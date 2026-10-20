// 前端功能开关（构建时注入）
// RENDERER_VITE_SHOW_TOKEN_COST=true/false 显式开关 token 与费用展示；
// 未设置时：开发模式（npm run dev）默认显示，打包构建（npm run build）默认隐藏。
// 关闭后只影响前端展示，后台 usage 账本照常记录。
const flag = import.meta.env.RENDERER_VITE_SHOW_TOKEN_COST
export const SHOW_TOKEN_COST =
  flag === undefined || flag === '' ? import.meta.env.DEV : flag === 'true'
