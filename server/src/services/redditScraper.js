/**
 * Reddit Image Scraper
 * Uses Reddit's public JSON API to find image posts.
 * No authentication required for public subreddits.
 */

const USER_AGENT = 'MineblockBot/1.0 (by /u/mineblock)';

/**
 * Search a subreddit for image posts
 * @param {string} subreddit - Subreddit name (without r/)
 * @param {string} query - Search query
 * @param {number} limit - Max results (default 50)
 * @returns {Array<{imageUrl, postUrl, title, author, upvotes, subreddit}>}
 */
export async function searchSubreddit(subreddit, query, limit = 50) {
  const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${encodeURIComponent(query)}&type=link&restrict_sr=on&sort=top&t=all&limit=${limit}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`Reddit API error ${res.status}: ${await res.text().then(t => t.slice(0, 200))}`);
  }

  const data = await res.json();
  const posts = data?.data?.children || [];

  return posts
    .map(post => post.data)
    .filter(post => isImagePost(post))
    .map(post => ({
      imageUrl: extractImageUrl(post),
      postUrl: `https://reddit.com${post.permalink}`,
      title: post.title,
      author: post.author,
      upvotes: post.ups || 0,
      subreddit: post.subreddit,
      sourceUrl: `https://reddit.com${post.permalink}`,
    }))
    .filter(item => item.imageUrl);
}

/**
 * Get hot/top posts from a subreddit
 */
export async function getTopPosts(subreddit, timeframe = 'week', limit = 25) {
  const url = `https://www.reddit.com/r/${subreddit}/top.json?t=${timeframe}&limit=${limit}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`Reddit API error ${res.status}`);
  }

  const data = await res.json();
  const posts = data?.data?.children || [];

  return posts
    .map(post => post.data)
    .filter(post => isImagePost(post))
    .map(post => ({
      imageUrl: extractImageUrl(post),
      postUrl: `https://reddit.com${post.permalink}`,
      title: post.title,
      author: post.author,
      upvotes: post.ups || 0,
      subreddit: post.subreddit,
      sourceUrl: `https://reddit.com${post.permalink}`,
    }))
    .filter(item => item.imageUrl);
}

function isImagePost(post) {
  if (post.is_video) return false;
  if (post.post_hint === 'image') return true;
  const url = post.url || '';
  return /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(url) ||
    url.includes('i.redd.it') ||
    url.includes('i.imgur.com');
}

function extractImageUrl(post) {
  const url = post.url || '';
  // Direct image links
  if (/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(url)) return url;
  // i.redd.it
  if (url.includes('i.redd.it')) return url;
  // imgur direct
  if (url.includes('i.imgur.com')) return url;
  // imgur page -> direct link
  if (url.includes('imgur.com') && !url.includes('/a/') && !url.includes('/gallery/')) {
    const id = url.split('/').pop().split('.')[0];
    return `https://i.imgur.com/${id}.jpg`;
  }
  // Reddit preview
  if (post.preview?.images?.[0]?.source?.url) {
    return post.preview.images[0].source.url.replace(/&amp;/g, '&');
  }
  return null;
}

/**
 * Default subreddits for organic image sourcing by topic
 */
export const ORGANIC_SUBREDDITS = {
  fitness: ['progresspics', 'fitness', 'loseit', 'brogress', 'GettingShredded'],
  health: ['Health', 'nutrition', 'Supplements'],
  lifestyle: ['malelivingspace', 'pics', 'OldSchoolCool', 'TheWayWeWere'],
  motivation: ['GetMotivated', 'MadeMeSmile'],
};
