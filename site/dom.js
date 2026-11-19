// Small DOM helpers shared by the tabs.

export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export const formatNumber = (value) => String(Math.round(value * 1000) / 1000);

// Short facts as a row of pills; empty facts are left out.
export function chips(facts) {
  const row = element('div', undefined, 'chips');
  for (const fact of facts.filter(Boolean)) row.append(element('span', fact, 'chip'));
  return row;
}

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
