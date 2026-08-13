import type { AgentPlan } from "./types";

const fallbackFeatures = ["核心数据可新增与更新", "关键状态实时反馈", "响应式且键盘可操作"];

export function planFromPrompt(prompt: string, iteration = false): AgentPlan {
  const clean = prompt.replace(/\s+/g, " ").trim();
  const name = clean
    .replace(/^(请|麻烦)?(帮我)?(做|制作|创建|开发|设计|实现)(一个|一款|个)?/u, "")
    .split(/[，,；;。.!！？?：:\n]/u)[0]
    .trim()
    .slice(0, 32) || "Nucleus App";
  const segments = clean
    .split(/[；;。.!！\n]/u)
    .map((item) => item.replace(/^(并且|同时|需要|支持|要求)\s*/u, "").trim())
    .filter((item) => item.length >= 4 && item.length <= 72);
  const inferred: string[] = [];
  if (/新增|添加|创建|录入/u.test(clean)) inferred.push("新增与管理核心数据");
  if (/搜索|筛选|过滤/u.test(clean)) inferred.push("搜索与条件筛选");
  if (/统计|进度|仪表盘|看板|实时/u.test(clean)) inferred.push("实时统计与状态反馈");
  if (/计时|倒计时|暂停|开始/u.test(clean)) inferred.push("可控制的计时流程");
  if (/删除|移除/u.test(clean)) inferred.push("安全删除与即时更新");
  const features = [...new Set([...segments.slice(0, 4), ...inferred, ...fallbackFeatures])].slice(0, 5);
  const visual = /霓虹|赛博/u.test(clean)
    ? "霓虹高对比游戏视觉"
    : /深色|暗色|dark/i.test(clean)
      ? "深色专业数据产品视觉"
      : /明亮|清新|轻量/u.test(clean)
        ? "明亮轻量的专业视觉"
        : "清晰、专业、内容优先的视觉";
  return {
    appName: name,
    summary: `${iteration ? "继续迭代" : "构建"}${name}：${clean.slice(0, 180)}`,
    features,
    design: `${visual}；桌面与手机响应式；交互状态和键盘焦点清晰可见。`,
  };
}
