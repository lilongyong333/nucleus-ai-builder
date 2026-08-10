import { describe, expect, it } from "vitest";
import { buildAppManifest, defaultRuntimeBlueprint } from "./app-manifest";
import type { AgentPlan, AppCollectionSchema } from "./types";

type EvalCase = { id: string; prompt: string; collection: string; access: AppCollectionSchema["access"]; auth: "anonymous" | "account" | "mixed" };

const archetypes: EvalCase[] = [
  { id: "todo-cn", prompt: "做一个任务待办清单", collection: "tasks", access: "owner", auth: "anonymous" },
  { id: "kanban-en", prompt: "Build a task kanban board", collection: "tasks", access: "owner", auth: "anonymous" },
  { id: "team-tasks", prompt: "团队账号登录后的任务看板", collection: "tasks", access: "owner", auth: "mixed" },
  { id: "snake-cn", prompt: "设计贪吃蛇游戏排行榜", collection: "scores", access: "public-read", auth: "anonymous" },
  { id: "game-en", prompt: "Create an arcade game with score leaderboard", collection: "scores", access: "public-read", auth: "anonymous" },
  { id: "account-game", prompt: "用户登录后玩的游戏和分数", collection: "scores", access: "public-read", auth: "mixed" },
  { id: "chat-cn", prompt: "实时聊天消息应用", collection: "messages", access: "public-write", auth: "anonymous" },
  { id: "feedback-en", prompt: "Customer feedback and comments", collection: "messages", access: "public-write", auth: "anonymous" },
  { id: "account-chat", prompt: "账号用户中心内的消息和评论", collection: "messages", access: "public-write", auth: "mixed" },
  { id: "inventory", prompt: "库存管理后台", collection: "items", access: "owner", auth: "anonymous" },
  { id: "crm", prompt: "销售 CRM 客户资料", collection: "items", access: "owner", auth: "anonymous" },
  { id: "account-crm", prompt: "带登录注册的 CRM", collection: "items", access: "owner", auth: "mixed" },
  { id: "habit", prompt: "习惯追踪打卡", collection: "items", access: "owner", auth: "anonymous" },
  { id: "finance", prompt: "个人预算和支出追踪", collection: "items", access: "owner", auth: "anonymous" },
  { id: "booking", prompt: "预约管理日历", collection: "items", access: "owner", auth: "anonymous" },
  { id: "portfolio", prompt: "作品集内容管理", collection: "items", access: "owner", auth: "anonymous" },
  { id: "quiz", prompt: "在线问答测验", collection: "items", access: "owner", auth: "anonymous" },
  { id: "recipe", prompt: "菜谱收藏工具", collection: "items", access: "owner", auth: "anonymous" },
  { id: "travel", prompt: "旅行计划生成器", collection: "items", access: "owner", auth: "anonymous" },
  { id: "learning", prompt: "学习进度追踪", collection: "items", access: "owner", auth: "anonymous" },
  { id: "issue", prompt: "Bug issue tracker", collection: "items", access: "owner", auth: "anonymous" },
  { id: "dashboard", prompt: "Analytics dashboard", collection: "items", access: "owner", auth: "anonymous" },
  { id: "form", prompt: "表单收集器", collection: "items", access: "owner", auth: "anonymous" },
  { id: "event", prompt: "活动报名页面", collection: "items", access: "owner", auth: "anonymous" },
  { id: "catalog", prompt: "商品目录管理", collection: "items", access: "owner", auth: "anonymous" },
  { id: "account-catalog", prompt: "账户登录后的商品目录", collection: "items", access: "owner", auth: "mixed" },
  { id: "team-wiki", prompt: "team wiki knowledge base", collection: "items", access: "owner", auth: "mixed" },
  { id: "support", prompt: "客服反馈 message center", collection: "messages", access: "public-write", auth: "anonymous" },
  { id: "speed", prompt: "中文打字速度 score challenge", collection: "scores", access: "public-read", auth: "anonymous" },
  { id: "project", prompt: "项目 task checklist", collection: "tasks", access: "owner", auth: "anonymous" },
];

const variants = ["桌面端优先", "移动端优先", "需要可访问性", "需要刷新后数据保留"] as const;
const cases = archetypes.flatMap((base) => variants.map((variant, index) => ({ ...base, id: `${base.id}-${index + 1}`, prompt: `${base.prompt}；${variant}` })));

describe("120-case fixed product contract eval", () => {
  it("keeps the fixed corpus at 120 independently addressable cases", () => {
    expect(cases).toHaveLength(120);
    expect(new Set(cases.map((item) => item.id)).size).toBe(120);
  });

  it.each(cases)("maps $id to a bounded isolated runtime contract", (testCase) => {
    const plan: AgentPlan = { appName: testCase.id, summary: testCase.prompt, features: [testCase.prompt], design: "responsive", acceptanceCriteria: ["核心流程可操作", "刷新后数据保留"] };
    const blueprint = defaultRuntimeBlueprint(testCase.prompt, plan);
    expect(blueprint.collections[0]?.name).toBe(testCase.collection);
    expect(blueprint.collections[0]?.access).toBe(testCase.access);
    expect(blueprint.authMode).toBe(testCase.auth);
    const manifest = buildAppManifest({ projectId: `eval-${testCase.id}`, versionId: "v1", plan, blueprint, databaseProvisionerReady: true });
    expect(manifest.backend.basePath).toBe(`/api/app-runtime/eval-${testCase.id}`);
    expect(manifest.capabilities.physicalDatabase).toBe("provisioning");
    expect(manifest.database.collections).toHaveLength(1);
    expect(manifest.database.collections[0].fields.every((field) => /^[a-z][a-zA-Z0-9_]{0,39}$/.test(field.name))).toBe(true);
  });
});
