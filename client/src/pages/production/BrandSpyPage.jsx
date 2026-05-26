import { useNavigate } from 'react-router-dom';
import BrandSpyFollowing from '../../components/brandspy/BrandSpyFollowing';

export default function BrandSpyPage() {
  const navigate = useNavigate();
  return (
    <div className="p-6 max-w-6xl">
      <BrandSpyFollowing
        apiBaseUrl="/api/v1/brand-spy"
        onBrandClick={(id) => navigate(`/app/brand-spy/${id}`)}
      />
    </div>
  );
}
