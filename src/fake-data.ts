/**
 * Deterministic fake content for rendering sampled trees. Shape mirrors the
 * newsfeed grammar's data contexts: screen fields, and one feed of articles
 * per Section.source value.
 */
export interface Article {
  title: string;
  dek: string;
  source: string;
  author: string;
  publishedAt: string;
  readTime: string;
  topic: string;
  imageUrl: string;
}

export interface Feed {
  name: string;
  articles: Article[];
}

export interface FeedData {
  screen: Record<string, string>;
  feeds: Record<string, Feed>;
  /** Rendered text for each grammar string key. */
  strings: Record<string, string>;
  /** Rendered label for each Button action. */
  actionLabels: Record<string, string>;
}

const HEADLINES: Array<[string, string, string, string, string]> = [
  ['City council approves new bike lane network', 'The plan adds 40 miles of protected lanes over three years, funded by a parking surcharge.', 'The Ledger', 'M. Okafor', 'Local'],
  ['Why the housing market stalled this quarter', 'Rates, inventory and a wait-and-see mood among sellers combined to freeze listings.', 'Marketwire', 'J. Alvarez', 'Economy'],
  ['A field guide to the season\'s best trail runs', 'From ridge loops to river paths, six routes that reward an early start.', 'Outside Hours', 'R. Chen', 'Sport'],
  ['Inside the lab racing to make cheaper batteries', 'A small team is betting on sodium instead of lithium. The chemistry is not the hard part.', 'The Ledger', 'S. Patel', 'Science'],
  ['The quiet return of the neighbourhood bookshop', 'Rents fell, foot traffic came back, and a generation of owners learned to sell online too.', 'Culture Desk', 'A. Moreau', 'Culture'],
  ['What we learned from a year of four-day weeks', 'Output held, turnover fell, and the meetings that survived were the ones people wanted.', 'Marketwire', 'D. Kim', 'Work'],
  ['Storm season forecast: later, wetter, less certain', 'Warmer seas shift the odds, but the models disagree on where the rain lands.', 'The Ledger', 'L. Ndiaye', 'Weather'],
  ['How a small town rebuilt its main street', 'The trick was not a grant. It was letting shops open before the paperwork cleared.', 'Culture Desk', 'T. Brennan', 'Local'],
  ['The case for boring index funds, again', 'Every cycle produces a new reason to pick stocks. The math has not changed.', 'Marketwire', 'J. Alvarez', 'Money'],
  ['A beginner\'s guide to sourdough that actually rises', 'Hydration, temperature and patience, in that order. Skip the fancy flour.', 'Kitchen Notes', 'E. Rossi', 'Food'],
  ['New transit cards go contactless next month', 'Riders can tap a phone or bank card. The old cards keep working until spring.', 'The Ledger', 'M. Okafor', 'Local'],
  ['The playoff picture after a wild weekend', 'Three upsets, one injury, and a tiebreaker nobody expected to matter.', 'Outside Hours', 'K. Osei', 'Sport'],
  ['Open-source maps are quietly eating the industry', 'Delivery apps, car makers and city planners now build on the same shared data.', 'Wired Notes', 'R. Chen', 'Tech'],
  ['Why your sleep tracker is probably wrong', 'Wrist sensors guess at sleep stages. The guesses are consistent, which is not the same as correct.', 'Wired Notes', 'S. Patel', 'Health'],
  ['The best cheap lunch spots near the station', 'Ten places under twelve dollars, ranked by the one thing that matters: would we go back.', 'Kitchen Notes', 'E. Rossi', 'Food'],
  ['A short history of the office chair', 'From the clerk\'s stool to the mesh throne, a design problem that was never really solved.', 'Culture Desk', 'A. Moreau', 'Design'],
  ['Schools trial later start times', 'Teenagers sleep more and arrive on time more often. Bus schedules are the hard part.', 'The Ledger', 'L. Ndiaye', 'Education'],
  ['Electric ferries cross the harbour for the first time', 'Quieter, cheaper to run, and charged in the nine minutes it takes to unload.', 'Wired Notes', 'D. Kim', 'Tech'],
  ['How to read a nutrition label in ten seconds', 'Serving size first, then sugar, then ignore the front of the box entirely.', 'Kitchen Notes', 'K. Osei', 'Health'],
  ['The museum that lets you touch everything', 'A new gallery bets that wear and tear is the price of actually being used.', 'Culture Desk', 'T. Brennan', 'Culture'],
];

const PALETTE = ['#c9d6df', '#f0c9a0', '#b8d8be', '#e7b8c8', '#d6cbe7', '#f2e2a2', '#a9d1e0', '#e0b8a9'];

/** A small inline SVG placeholder so the gallery needs no network. */
function placeholder(i: number): string {
  const a = PALETTE[i % PALETTE.length];
  const b = PALETTE[(i + 3) % PALETTE.length];
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='300'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${a}'/><stop offset='1' stop-color='${b}'/></linearGradient></defs><rect width='400' height='300' fill='url(#g)'/><circle cx='${80 + (i * 37) % 240}' cy='${70 + (i * 53) % 160}' r='46' fill='rgba(255,255,255,0.45)'/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const ARTICLES: Article[] = HEADLINES.map(([title, dek, source, author, topic], i) => ({
  title, dek, source, author, topic,
  publishedAt: `${(i % 11) + 1}h ago`,
  readTime: `${3 + (i % 6)} min read`,
  imageUrl: placeholder(i),
}));

function slice(start: number, n: number): Article[] {
  return Array.from({ length: n }, (_, k) => ARTICLES[(start + k) % ARTICLES.length]);
}

export const fakeData: FeedData = {
  screen: { greeting: 'Good morning, Sam', todayDate: 'Thursday, 11 September' },
  feeds: {
    topStories: { name: 'Top Stories', articles: slice(0, 10) },
    forYou: { name: 'For You', articles: slice(5, 10) },
    following: { name: 'Following', articles: slice(11, 10) },
    continueReading: { name: 'Continue Reading', articles: slice(3, 10) },
    saved: { name: 'Saved', articles: slice(14, 10) },
  },
  strings: {
    'header.home': 'Home',
    'header.forYou': 'For You',
    'section.topStories': 'Top Stories',
    'section.forYou': 'For You',
    'section.following': 'Following',
    'section.continueReading': 'Continue Reading',
    'section.saved': 'Saved',
  },
  actionLabels: {
    refresh: 'Refresh', search: 'Search', seeMore: 'See more',
    read: 'Read', save: 'Save', share: 'Share', follow: 'Follow', dismiss: 'Hide',
  },
};
