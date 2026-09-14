export function protectSpreadsheetCell(value: string): string {
  return /^[\t\r\n ]*[=+\-@]/.test(value) ? `'${value}` : value;
}

function quoteCsv(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function createCsv(
  headers: string[],
  rows: Array<Record<string, string>>,
  unprotectedHeaders: ReadonlySet<string> = new Set(),
) {
  const line = (row: Record<string, string>) =>
    headers
      .map((header) => {
        const value = row[header] ?? "";
        return quoteCsv(
          unprotectedHeaders.has(header)
            ? value
            : protectSpreadsheetCell(value),
        );
      })
      .join(",");
  return `\uFEFF${[headers.map(quoteCsv).join(","), ...rows.map(line)].join(
    "\r\n",
  )}\r\n`;
}
