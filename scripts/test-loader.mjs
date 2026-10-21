// 让 node --test 能解析项目里不带扩展名的 TypeScript 相对导入。
export async function resolve(specifier, context, nextResolve) {
  const relative = specifier.startsWith('./') || specifier.startsWith('../')
  const bare = !/\.[a-zA-Z0-9]+$/.test(specifier)
  if (relative && bare) {
    return nextResolve(`${specifier}.ts`, context)
  }
  return nextResolve(specifier, context)
}
