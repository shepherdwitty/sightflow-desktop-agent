// 打包时 electron.vite.config.ts 会把下面两次读取替换成构建当时的字面量。
// 商业包启动时没有环境变量，也不会因此退回开源界面。
// 单测直接跑这份源码，所以这里仍读真实环境变量。
export function isCommercialBuild(): boolean {
  return process.env.SIGHTFLOW_COMMERCIAL === '1' || process.env.RENDERER_VITE_COMMERCIAL === 'true'
}

const MODEL_LEAK = /doubao[\w.-]*|volcengine|volces\.com|byteplus|openai|anthropic|claude|gpt-[\w.-]*|deepseek|glm-[\w.-]*/gi

/** 商业构建的运行日志不带模型名、供应商名。已经写好的中文结论原样保留。 */
export function scrubCommercialLog(content: string): string {
  if (!isCommercialBuild()) return content
  return content.replace(MODEL_LEAK, '服务')
}
