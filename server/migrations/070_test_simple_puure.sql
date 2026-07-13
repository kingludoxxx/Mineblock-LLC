-- Simple test: insert Puure with minimal data to diagnose migration issue
INSERT INTO product_profiles (
  product_code,
  short_name,
  full_name,
  description,
  price
) VALUES (
  'PUURE_TEST',
  'Puure Test',
  'Puure™ Test Product',
  'Test insertion to verify migrations are running',
  '99'
) ON CONFLICT (product_code) DO NOTHING;
