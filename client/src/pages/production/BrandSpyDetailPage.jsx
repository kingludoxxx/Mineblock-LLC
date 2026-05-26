import { useParams, useNavigate } from 'react-router-dom';
import BrandDetail from '../../components/brandspy/BrandDetail';

export default function BrandSpyDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  return (
    <BrandDetail
      apiBaseUrl="/api/v1/brand-spy"
      brandId={id}
      onBack={() => navigate('/app/brand-spy')}
    />
  );
}
