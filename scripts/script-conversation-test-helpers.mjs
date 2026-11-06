export function latestDiscussion(messages) {
  return (
    messages
      .filter((m) => m.role === "user")
      .flatMap((m) => {
        try {
          const data = JSON.parse(m.content);
          return typeof data.message === "string" ? [data.message] : [];
        } catch {
          return [];
        }
      })
      .at(-1) || ""
  );
}
export async function discussThenGenerate(page, { onRequest = () => {} } = {}) {
  onRequest("discussion");
  await page
    .getByRole("button", { name: /^(讨论处理方案|发送补充意见)$/ })
    .click();
  await page
    .locator(".generator-message")
    .filter({ hasText: "方案已输出" })
    .first()
    .waitFor({ timeout: 320000 });
  const error = page.locator(".generator-message.error");
  if (await error.count()) throw new Error(await error.first().innerText());
  onRequest("generation");
  await page
    .getByRole("button", { name: "确认方案并生成脚本", exact: true })
    .click();
}
