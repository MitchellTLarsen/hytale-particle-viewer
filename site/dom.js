// Small DOM helpers shared by the tabs.

export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export const formatNumber = (value) => String(Math.round(value * 1000) / 1000);

export function button(text, onClick, className) {
  const node = element('button', text, className);
  node.addEventListener('click', onClick);
  return node;
}

// Rows are arrays of cells; a cell is a node, a string or a number.
export function table(headers, rows) {
  const node = element('table');
  const head = element('tr');
  for (const header of headers) head.append(element('th', header));
  node.append(head);
  for (const cells of rows) {
    const row = element('tr');
    for (const cell of cells) {
      const td = element('td');
      td.append(cell ?? '');
      row.append(td);
    }
    node.append(row);
  }
  return node;
}

// Entries are [title, data] pairs.
export function rawJson(entries) {
  const json = element('details');
  json.append(element('summary', 'Raw JSON'));
  for (const [title, data] of entries) json.append(element('h3', title), element('pre', JSON.stringify(data, null, 2)));
  return json;
}
