export default function Tabs({ tabs, activeTab, onChange }) {
  return (
    <div className="flex gap-1 border-b border-border-subtle">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          onClick={() => onChange(tab.value)}
          className={`px-3 py-2 text-sm font-medium transition-colors border-b-2 -mb-px cursor-pointer
            ${
              activeTab === tab.value
                ? 'border-accent text-text-primary'
                : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
