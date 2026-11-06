(() => {
  let code = candidate.trim();
  if (code.startsWith("```")) {
    const match = code.match(/^```(?:javascript|js)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
    if (!match) throw new Error("模型返回的代码围栏不完整，请重新生成");
    code = match[1].trim();
  }
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "script", locations: true });
  } catch (error) {
    throw new Error(`生成的脚本语法不正确（第 ${error.loc?.line || 1} 行），请修改要求或重新生成`);
  }
  const entries = ast.body.filter((node) => node.type === "FunctionDeclaration" && node.id?.name === "transform");
  if (entries.length !== 1 || entries[0].async || entries[0].generator || entries[0].params.length !== 1 || entries[0].params[0].type !== "Identifier") {
    throw new Error("生成的脚本必须包含同步单参数函数 transform(text)，请重新生成");
  }
  return code;
})()
