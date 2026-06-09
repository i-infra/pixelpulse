export interface CsvColumn {
  name: string;
  units: string;
  precision: number;
  data: number[];
}

export function downloadCSV(columns: CsvColumn[]): void {
  const header = columns.map(c => `"${c.name} (${c.units})"`).join(',') + '\n';
  const rows: string[] = [header];

  for (let i = 0; i < columns[0].data.length; i++) {
    rows.push(
      columns.map(c => c.data[i].toFixed(c.precision)).join(',') + '\n',
    );
  }

  downloadFile(rows, 'text/csv', `export${+new Date()}.csv`);
}

export function downloadFile(data: BlobPart[], type: string, filename: string): void {
  const url = URL.createObjectURL(new Blob(data, { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10);
}
