import { env } from "cloudflare:workers";
import { ensureSchema } from "./db";
import type { Organization, OrganizationMember, ProjectApproval } from "./types";

type D1Row = Record<string, string | number | null>;
type OrganizationRole = OrganizationMember["role"];

export class OrganizationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "OrganizationError";
  }
}

function database(): D1Database {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new OrganizationError("组织数据库暂不可用", 503);
  return binding;
}

export async function claimOrganizationInvites(subjectId: string, email: string): Promise<number> {
  await ensureSchema();
  const normalized = email.trim().toLowerCase();
  if (!normalized) return 0;
  const d1 = database();
  const invites = await d1.prepare(`SELECT * FROM organization_members WHERE lower(email)=? AND status='invited'`).bind(normalized).all<D1Row>();
  let claimed = 0;
  for (const invite of invites.results ?? []) {
    const existing = await d1.prepare(`SELECT id FROM organization_members WHERE organization_id=? AND subject_id=?`).bind(String(invite.organization_id), subjectId).first<{ id: string }>();
    if (existing) {
      await d1.prepare(`DELETE FROM organization_members WHERE id=?`).bind(String(invite.id)).run();
      continue;
    }
    const result = await d1.prepare(`UPDATE organization_members SET subject_id=?,status='active',updated_at=? WHERE id=? AND status='invited'`).bind(subjectId, new Date().toISOString(), String(invite.id)).run();
    claimed += Number(result.meta.changes ?? 0);
  }
  return claimed;
}

export async function getCurrentOrganization(subjectId: string): Promise<Organization | null> {
  await ensureSchema();
  const row = await database().prepare(`SELECT o.* FROM organizations o JOIN organization_members m ON m.organization_id=o.id WHERE m.subject_id=? AND m.status='active' ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END,o.created_at ASC LIMIT 1`).bind(subjectId).first<D1Row>();
  if (!row) return null;
  return organizationFromRow(row);
}

export async function getProjectOrganization(projectId: string, subjectId: string): Promise<Organization | null> {
  await ensureSchema();
  const row = await database().prepare(`SELECT o.* FROM projects p JOIN organizations o ON o.id=p.organization_id JOIN organization_members m ON m.organization_id=o.id AND m.subject_id=? AND m.status='active' WHERE p.id=? LIMIT 1`).bind(subjectId, projectId).first<D1Row>();
  return row ? organizationFromRow(row) : null;
}

export async function inviteOrganizationMember(subjectId: string, email: string, role: Exclude<OrganizationRole, "owner">, projectId?: string): Promise<Organization> {
  const organization = await requireManagedOrganization(subjectId, ["owner", "admin"], projectId);
  const normalized = email.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(normalized)) throw new OrganizationError("请输入有效邮箱");
  const now = new Date().toISOString();
  const invitedSubject = `invite:${await shortDigest(normalized)}`;
  await database().prepare(`INSERT INTO organization_members (id,organization_id,subject_id,email,role,status,created_at,updated_at) VALUES (?,?,?,?,?,'invited',?,?) ON CONFLICT(organization_id,subject_id) DO UPDATE SET email=excluded.email,role=excluded.role,status='invited',updated_at=excluded.updated_at`).bind(crypto.randomUUID(), organization.id, invitedSubject, normalized, role, now, now).run();
  return projectId ? (await getProjectOrganization(projectId, subjectId))! : (await getCurrentOrganization(subjectId))!;
}

export async function updateOrganizationSettings(subjectId: string, input: { name?: string; monthlyTokenLimit?: number; approvalRequired?: boolean }, projectId?: string): Promise<Organization> {
  const organization = await requireManagedOrganization(subjectId, ["owner", "admin"], projectId);
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 100) : organization.name;
  const monthlyTokenLimit = typeof input.monthlyTokenLimit === "number" && Number.isFinite(input.monthlyTokenLimit)
    ? Math.max(50_000, Math.min(50_000_000, Math.floor(input.monthlyTokenLimit)))
    : organization.monthlyTokenLimit;
  const approvalRequired = typeof input.approvalRequired === "boolean" ? input.approvalRequired : organization.approvalRequired;
  await database().prepare(`UPDATE organizations SET name=?,monthly_token_limit=?,approval_required=?,updated_at=? WHERE id=?`).bind(name, monthlyTokenLimit, approvalRequired ? 1 : 0, new Date().toISOString(), organization.id).run();
  return projectId ? (await getProjectOrganization(projectId, subjectId))! : (await getCurrentOrganization(subjectId))!;
}

export async function updateOrganizationMember(subjectId: string, memberId: string, input: { role?: Exclude<OrganizationRole, "owner">; status?: "active" | "suspended" }): Promise<Organization> {
  const organization = await requireOrganizationRole(subjectId, ["owner", "admin"]);
  const member = await database().prepare(`SELECT * FROM organization_members WHERE id=? AND organization_id=?`).bind(memberId, organization.id).first<D1Row>();
  if (!member) throw new OrganizationError("成员不存在", 404);
  if (String(member.role) === "owner") throw new OrganizationError("不能通过成员接口修改组织所有者", 403);
  const role = input.role ?? String(member.role) as Exclude<OrganizationRole, "owner">;
  const status = input.status ?? String(member.status) as "active" | "suspended";
  await database().prepare(`UPDATE organization_members SET role=?,status=?,updated_at=? WHERE id=? AND organization_id=?`).bind(role, status, new Date().toISOString(), memberId, organization.id).run();
  return (await getCurrentOrganization(subjectId))!;
}

export async function requestProjectApproval(projectId: string, versionId: string, subjectId: string, comment?: string): Promise<ProjectApproval> {
  const role = await projectOrganizationRole(projectId, subjectId);
  if (!role || role === "viewer") throw new OrganizationError("没有权限发起审批", 403);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await database().prepare(`UPDATE project_approvals SET status='rejected',reviewed_by=?,comment='被新的审批请求替代',updated_at=? WHERE project_id=? AND version_id=? AND status='pending'`).bind(subjectId, now, projectId, versionId).run();
  await database().prepare(`INSERT INTO project_approvals (id,project_id,version_id,status,requested_by,reviewed_by,comment,created_at,updated_at) VALUES (?,?,?,'pending',?,NULL,?,?,?)`).bind(id, projectId, versionId, subjectId, comment?.slice(0, 500) ?? null, now, now).run();
  return (await getProjectApproval(projectId, versionId))!;
}

export async function decideProjectApproval(projectId: string, approvalId: string, subjectId: string, decision: "approved" | "rejected", comment?: string): Promise<ProjectApproval> {
  const role = await projectOrganizationRole(projectId, subjectId);
  if (!role || (role !== "owner" && role !== "admin" && role !== "reviewer")) throw new OrganizationError("当前角色不能审批发布", 403);
  const now = new Date().toISOString();
  const row = await database().prepare(`UPDATE project_approvals SET status=?,reviewed_by=?,comment=?,updated_at=? WHERE id=? AND project_id=? AND status='pending' RETURNING *`).bind(decision, subjectId, comment?.slice(0, 500) ?? null, now, approvalId, projectId).first<D1Row>();
  if (!row) throw new OrganizationError("审批不存在或已经处理", 404);
  return approvalFromRow(row);
}

export async function listProjectApprovals(projectId: string, subjectId: string): Promise<ProjectApproval[]> {
  if (!await projectOrganizationRole(projectId, subjectId)) throw new OrganizationError("没有权限查看审批", 403);
  const result = await database().prepare(`SELECT * FROM project_approvals WHERE project_id=? ORDER BY created_at DESC LIMIT 50`).bind(projectId).all<D1Row>();
  return (result.results ?? []).map(approvalFromRow);
}

export async function publicationApprovalState(projectId: string, versionId: string): Promise<{ required: boolean; approved: boolean; approval: ProjectApproval | null }> {
  await ensureSchema();
  const row = await database().prepare(`SELECT o.approval_required FROM projects p LEFT JOIN organizations o ON o.id=p.organization_id WHERE p.id=?`).bind(projectId).first<D1Row>();
  const required = Number(row?.approval_required ?? 0) === 1;
  const approval = await getProjectApproval(projectId, versionId);
  return { required, approved: !required || approval?.status === "approved", approval };
}

export async function organizationHasTokenBudget(projectId: string): Promise<boolean> {
  await ensureSchema();
  const month = new Date().toISOString().slice(0, 7);
  const row = await database().prepare(`SELECT o.monthly_token_limit,COALESCE(SUM(CASE WHEN u.kind='model_tokens' THEN u.quantity ELSE 0 END),0) AS used FROM projects p LEFT JOIN organizations o ON o.id=p.organization_id LEFT JOIN usage_events u ON u.organization_id=o.id AND substr(u.created_at,1,7)=? WHERE p.id=? GROUP BY o.id,o.monthly_token_limit`).bind(month, projectId).first<D1Row>();
  if (!row?.monthly_token_limit) return true;
  return Number(row.used ?? 0) < Number(row.monthly_token_limit);
}

export async function projectOrganizationRole(projectId: string, subjectId: string): Promise<OrganizationRole | null> {
  await ensureSchema();
  const row = await database().prepare(`SELECT CASE WHEN p.owner_id=? THEN 'owner' ELSE m.role END AS role FROM projects p LEFT JOIN organization_members m ON m.organization_id=p.organization_id AND m.subject_id=? AND m.status='active' WHERE p.id=? AND (p.owner_id=? OR m.id IS NOT NULL)`).bind(subjectId, subjectId, projectId, subjectId).first<D1Row>();
  return row?.role ? String(row.role) as OrganizationRole : null;
}

export async function requireProjectOrganizationRole(projectId: string, subjectId: string, roles: OrganizationRole[]): Promise<OrganizationRole> {
  const role = await projectOrganizationRole(projectId, subjectId);
  if (!role) throw new OrganizationError("项目不存在或没有访问权限", 404);
  if (!roles.includes(role)) throw new OrganizationError("当前组织角色没有执行此操作的权限", 403);
  return role;
}

async function getProjectApproval(projectId: string, versionId: string): Promise<ProjectApproval | null> {
  const row = await database().prepare(`SELECT * FROM project_approvals WHERE project_id=? AND version_id=? ORDER BY created_at DESC LIMIT 1`).bind(projectId, versionId).first<D1Row>();
  return row ? approvalFromRow(row) : null;
}

async function requireOrganizationRole(subjectId: string, roles: OrganizationRole[]): Promise<Organization> {
  const organization = await getCurrentOrganization(subjectId);
  if (!organization) throw new OrganizationError("组织不存在", 404);
  const member = organization.members.find((item) => item.subjectId === subjectId && item.status === "active");
  if (!member || !roles.includes(member.role)) throw new OrganizationError("没有组织管理权限", 403);
  return organization;
}

async function requireManagedOrganization(subjectId: string, roles: OrganizationRole[], projectId?: string): Promise<Organization> {
  if (!projectId) return requireOrganizationRole(subjectId, roles);
  const role = await requireProjectOrganizationRole(projectId, subjectId, roles);
  const organization = await getProjectOrganization(projectId, subjectId);
  if (!organization || !roles.includes(role)) throw new OrganizationError("没有组织管理权限", 403);
  return organization;
}

async function organizationFromRow(row: D1Row): Promise<Organization> {
  const members = await database().prepare(`SELECT * FROM organization_members WHERE organization_id=? ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,created_at ASC`).bind(String(row.id)).all<D1Row>();
  const month = new Date().toISOString().slice(0, 7);
  const usage = await database().prepare(`SELECT COALESCE(SUM(CASE WHEN kind='model_tokens' THEN quantity ELSE 0 END),0) AS tokens,COALESCE(SUM(CASE WHEN kind='model_calls' THEN quantity ELSE 0 END),0) AS model_calls,COALESCE(SUM(CASE WHEN kind='database_write' THEN quantity ELSE 0 END),0) AS database_writes FROM usage_events WHERE organization_id=? AND substr(created_at,1,7)=?`).bind(String(row.id), month).first<D1Row>();
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    name: String(row.name),
    plan: String(row.plan) as Organization["plan"],
    monthlyTokenLimit: Number(row.monthly_token_limit),
    approvalRequired: Number(row.approval_required ?? 0) === 1,
    members: (members.results ?? []).map(memberFromRow),
    usage: { month, tokens: Number(usage?.tokens ?? 0), modelCalls: Number(usage?.model_calls ?? 0), databaseWrites: Number(usage?.database_writes ?? 0) },
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function memberFromRow(row: D1Row): OrganizationMember {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    subjectId: String(row.subject_id),
    email: row.email ? String(row.email) : null,
    role: String(row.role) as OrganizationMember["role"],
    status: String(row.status) as OrganizationMember["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function approvalFromRow(row: D1Row): ProjectApproval {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    versionId: String(row.version_id),
    status: String(row.status) as ProjectApproval["status"],
    requestedBy: String(row.requested_by),
    reviewedBy: row.reviewed_by ? String(row.reviewed_by) : null,
    comment: row.comment ? String(row.comment) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function shortDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).slice(0, 12).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
