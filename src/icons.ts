const svg = (body: string, fill = false) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="${
    fill ? "currentColor" : "none"
  }" stroke="${fill ? "none" : "currentColor"}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const icons = {
  box: svg('<rect x="3.5" y="8" width="17" height="8" rx="1"/>', true),
  text: svg('<path d="M5 6h14M12 6v13M9 19h6"/>'),
  find: svg('<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 5 5"/>'),
  undo: svg('<path d="M9 13 4 8l5-5"/><path d="M4 8h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  redo: svg('<path d="m15 13 5-5-5-5"/><path d="M20 8H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  minus: svg('<path d="M6 12h12"/>'),
  plus: svg('<path d="M6 12h12M12 6v12"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  close: svg('<path d="m6 6 12 12M18 6 6 18"/>'),
  download: svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  chevron: svg('<path d="m6 9 6 6 6-6"/>'),
  file: svg('<path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z"/><path d="M14 3v4h4"/>'),
  fileText: svg(
    '<path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z"/><path d="M14 3v4h4M9 12h6M9 15.5h6M9 9h2"/>',
  ),
  copy: svg(
    '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="1.5"/><path d="M15.5 8.5V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9.5a1 1 0 0 0 1 1h3.5"/>',
  ),
  merge: svg('<path d="M6 3v4a5 5 0 0 0 5 5h2a5 5 0 0 0 5-5V3"/><path d="M12 12v9M8.5 17.5 12 21l3.5-3.5"/>'),
  scissors: svg(
    '<circle cx="6" cy="6.5" r="2.75"/><circle cx="6" cy="17.5" r="2.75"/><path d="M8.3 8.1 20 18M8.3 15.9 20 6"/>',
  ),
  grip: svg(
    '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
    true,
  ),
};
