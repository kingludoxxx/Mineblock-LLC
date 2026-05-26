import { useNavigate } from 'react-router-dom';
import BrandSpyFollowing from '../../components/brandspy/BrandSpyFollowing';

export default function BrandSpyPage() {
  const navigate = useNavigate();
  return (
    <BrandSpyFollowing
      apiBaseUrl="/api/v1/brand-spy"
      onBrandClick={(id) => navigate(`/app/brand-spy/${id}`)}
    />
  );
}
