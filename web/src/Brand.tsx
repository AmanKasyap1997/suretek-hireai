import logo from './assets/suretek-logo.png';

export function Brand() {
  return (
    <div className="brand-lockup">
      <img src={logo} alt="Suretek" width="1800" height="435" />
      <span className="product-name">
        Suretek <strong>HireAI</strong>
      </span>
    </div>
  );
}

export function WorkspaceIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    organizations:
      'M3 21V3h12v18M15 9h6v12M6 7h1M10 7h1M6 11h1M10 11h1M6 15h1M10 15h1M18 13h1M18 17h1',
    team: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM17 9h5M19.5 6.5v5',
    home: 'M3 10 12 3l9 7M5 9v12h5v-7h4v7h5V9',
    dashboard: 'M3 3h8v8H3V3Zm10 0h8v5h-8V3Zm0 7h8v11h-8V10ZM3 13h8v5H3v-5Z',
    jobs: 'M8 7V4h8v3M3 7h18v14H3V7Zm0 5h18M10 12v3h4v-3',
    applications: 'M6 3h9l4 4v14H6V3Zm9 0v5h4M9 12h7M9 16h7',
    candidates:
      'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 4a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
    interviews: 'M3 5h18v16H3V5Zm4-3v6M17 2v6M3 11h18M8 15h1M14 15h1',
    reports: 'M4 21V11h4v10M10 21V6h4v15M16 21V2h4v19',
    offers: 'M6 3h12v18H6V3Zm3 5h6M9 12h6M9 16h3',
    people:
      'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM17 9h5M19.5 6.5v5',
    settings:
      'M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z',
    lock: 'M5 10h14v11H5V10Zm3 0V6a4 4 0 0 1 8 0v4M12 14v3',
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="workspace-icon"
    >
      <path d={paths[name] ?? paths.home} />
    </svg>
  );
}
