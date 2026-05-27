import BrandLeague from '../../components/brandspy/BrandLeague';

export default function BrandSpyLeaguePage() {
  return (
    <div className="h-full flex flex-col overflow-hidden">
      <BrandLeague apiBaseUrl="/api/v1/brand-spy" />
    </div>
  );
}
