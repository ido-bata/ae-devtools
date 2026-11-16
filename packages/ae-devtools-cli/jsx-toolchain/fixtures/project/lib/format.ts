export function formatReport(title: string, items: string[]): string {
  let out = "# " + title + "\n";
  for (let i = 0; i < items.length; i++) {
    out += "- " + items[i] + "\n";
  }
  return out;
}
