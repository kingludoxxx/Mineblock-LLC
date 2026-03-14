// Mock data for Intel section

const brands = [
  { id: 'b1', name: 'Nike', avatar: null, domain: 'nike.com', adCount: 1243 },
  { id: 'b2', name: 'Adidas', avatar: null, domain: 'adidas.com', adCount: 987 },
  { id: 'b3', name: 'Apple', avatar: null, domain: 'apple.com', adCount: 562 },
  { id: 'b4', name: 'Samsung', avatar: null, domain: 'samsung.com', adCount: 834 },
  { id: 'b5', name: 'Coca-Cola', avatar: null, domain: 'coca-cola.com', adCount: 421 },
  { id: 'b6', name: 'Tesla', avatar: null, domain: 'tesla.com', adCount: 189 },
  { id: 'b7', name: 'Amazon', avatar: null, domain: 'amazon.com', adCount: 2150 },
  { id: 'b8', name: 'Google', avatar: null, domain: 'google.com', adCount: 1567 },
  { id: 'b9', name: 'Meta', avatar: null, domain: 'meta.com', adCount: 743 },
  { id: 'b10', name: 'Spotify', avatar: null, domain: 'spotify.com', adCount: 356 },
  { id: 'b11', name: 'Netflix', avatar: null, domain: 'netflix.com', adCount: 612 },
  { id: 'b12', name: 'Disney+', avatar: null, domain: 'disneyplus.com', adCount: 298 },
];

const platforms = ['facebook', 'instagram', 'google', 'youtube', 'tiktok'];
const adFormats = ['image', 'video', 'carousel'];
const ctas = ['Shop Now', 'Learn More', 'Sign Up', 'Download', 'Get Offer', 'Book Now', 'Contact Us', 'Watch More'];
const countries = ['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'JP', 'BR', 'IN', 'MX'];
const languages = ['English', 'Spanish', 'French', 'German', 'Japanese', 'Portuguese', 'Hindi', 'Chinese'];

const adCopies = [
  "Discover the future of fitness. Our new collection combines cutting-edge technology with sustainable materials to bring you the ultimate workout experience. Whether you're hitting the gym or running outdoors, we've got you covered.\n\nFree shipping on orders over $50. Limited time offer.",
  "Transform your morning routine with our premium blend. Crafted from the finest ingredients sourced from around the world. Each sip delivers a perfect balance of flavor and energy.\n\nOrder now and get 20% off your first purchase. Use code MORNING20 at checkout.",
  "Your home deserves the best. Explore our curated collection of smart home devices that seamlessly integrate into your daily life. From lighting to security, we make smart living effortless.\n\nShop the collection today.",
  "Summer is here and so is our biggest sale of the year! Up to 70% off on selected items. Don't miss out on incredible deals across all categories.\n\nFree returns within 30 days. No questions asked.",
  "Level up your game with our latest release. Featuring stunning graphics, immersive gameplay, and an epic storyline that will keep you hooked for hours.\n\nAvailable now on all platforms. Download for free.",
  "The wait is over. Introducing our most advanced product yet. Designed with precision engineering and built to last.\n\nPre-order now and be among the first to experience the future.",
  "Join millions of satisfied customers who have already made the switch. Our service is rated #1 by industry experts.\n\nStart your free trial today. No credit card required.",
  "Unlock your potential with our comprehensive online courses. Learn from world-class instructors at your own pace.\n\nEnroll now and get lifetime access to all course materials.",
];

const landingPages = [
  'https://example.com/shop/new-collection',
  'https://example.com/product/premium-blend',
  'https://example.com/smart-home',
  'https://example.com/summer-sale',
  'https://example.com/game/download',
  'https://example.com/pre-order',
  'https://example.com/free-trial',
  'https://example.com/courses',
];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomDate(daysBack = 90) {
  const d = new Date();
  d.setDate(d.getDate() - Math.floor(Math.random() * daysBack));
  return d.toISOString().split('T')[0];
}

function randomSubset(arr, min = 1, max = 3) {
  const count = Math.floor(Math.random() * (max - min + 1)) + min;
  const shuffled = [...arr].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
}

function generateAd(id, platformFilter = null) {
  const brand = randomFrom(brands);
  const platform = platformFilter || randomFrom(platforms);
  const format = randomFrom(adFormats);
  const firstSeen = randomDate(90);
  const firstSeenDate = new Date(firstSeen);
  const daysRunning = Math.floor((Date.now() - firstSeenDate.getTime()) / (1000 * 60 * 60 * 24));
  const lastSeen = daysRunning > 3 ? randomDate(3) : firstSeen;

  return {
    id: `ad-${id}`,
    brand,
    platform,
    format,
    cta: randomFrom(ctas),
    adCopy: randomFrom(adCopies),
    landingPage: randomFrom(landingPages),
    countries: randomSubset(countries, 1, 4),
    language: randomFrom(languages),
    firstSeen,
    lastSeen,
    daysRunning,
    saved: Math.random() > 0.8,
    following: Math.random() > 0.7,
    imageAspect: randomFrom(['square', 'landscape', 'portrait']),
    videoDuration: format === 'video' ? Math.floor(Math.random() * 120) + 5 : null,
    carouselCount: format === 'carousel' ? Math.floor(Math.random() * 8) + 2 : null,
    // TikTok specific
    views: Math.floor(Math.random() * 1000000),
    likes: Math.floor(Math.random() * 50000),
    comments: Math.floor(Math.random() * 5000),
    shares: Math.floor(Math.random() * 2000),
    // TikTok Shop specific
    price: format === 'image' ? (Math.random() * 200 + 5).toFixed(2) : null,
    originalPrice: format === 'image' ? (Math.random() * 300 + 50).toFixed(2) : null,
    soldCount: Math.floor(Math.random() * 10000),
    rating: (Math.random() * 2 + 3).toFixed(1),
  };
}

export function generateAds(count = 30, platformFilter = null) {
  return Array.from({ length: count }, (_, i) => generateAd(i + 1, platformFilter));
}

export function generateMetaAds(count = 30) {
  return Array.from({ length: count }, (_, i) => {
    const ad = generateAd(i + 1, randomFrom(['facebook', 'instagram']));
    return ad;
  });
}

export function generateGoogleAds(count = 30) {
  return generateAds(count, 'google');
}

export function generateYouTubeAds(count = 30) {
  return generateAds(count, 'youtube').map((ad) => ({ ...ad, format: 'video', videoDuration: Math.floor(Math.random() * 180) + 6 }));
}

export function generateTikTokAds(count = 30) {
  return generateAds(count, 'tiktok');
}

export function generateTikTokShopAds(count = 30) {
  return generateAds(count, 'tiktok').map((ad) => ({
    ...ad,
    price: (Math.random() * 200 + 5).toFixed(2),
    originalPrice: (Math.random() * 300 + 50).toFixed(2),
    soldCount: Math.floor(Math.random() * 10000),
    rating: (Math.random() * 2 + 3).toFixed(1),
  }));
}

export function generateTikTokOrganic(count = 30) {
  return generateAds(count, 'tiktok').map((ad) => ({
    ...ad,
    format: 'video',
    videoDuration: Math.floor(Math.random() * 60) + 5,
    isOrganic: true,
  }));
}

export { brands, platforms, countries, languages, ctas };
