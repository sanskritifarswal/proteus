import type { Grammar } from '../grammar-types.ts';

/**
 * Starter grammar: the home screen of a reading / news app
 * (think Apple News, Pocket, Artifact).
 *
 * Why this app: engagement signals are dense and cheap (tap, dwell,
 * scroll-past, save, dismiss), presentation genuinely varies between users
 * (hero cards vs dense lists vs carousels), and there is no transaction
 * step to muddy the reward signal.
 *
 * What the model chooses: structure and presentation.
 * What it never chooses: content (bound from data), ranking (the feed
 * order is data), or theme (colours/spacing live in the renderer).
 */
export const newsfeed = {
  name: 'newsfeed',
  version: '0.1.0',
  root: 'Screen',
  rootContext: 'screen',

  contexts: {
    screen: {
      description: 'Top-level user context.',
      fields: { greeting: 'text', todayDate: 'text' },
    },
    feed: {
      description: 'A named, already-ranked collection of articles.',
      fields: { name: 'text' },
    },
    article: {
      description: 'One article within a feed.',
      fields: {
        title: 'text',
        dek: 'text',
        source: 'text',
        author: 'text',
        publishedAt: 'text',
        readTime: 'text',
        topic: 'text',
        imageUrl: 'image',
      },
    },
  },

  strings: [
    'header.home',
    'header.forYou',
    'section.topStories',
    'section.forYou',
    'section.following',
    'section.continueReading',
    'section.saved',
  ],

  components: {
    Screen: {
      description: 'Root. One vertical scroll of sections with an optional header.',
      contexts: ['screen'],
      slots: {
        header: { accepts: ['Header'], min: 0, max: 1 },
        sections: { accepts: ['Section'], min: 1, max: 5 },
      },
    },

    Header: {
      description: 'Screen title bar with an optional utility action.',
      contexts: ['screen'],
      slots: {
        title: { accepts: ['Text'], min: 1, max: 1, childProps: { role: ['title'] } },
        action: { accepts: ['Button'], min: 0, max: 1 },
      },
    },

    Section: {
      description: 'Binds one feed and establishes the `feed` context for its children.',
      contexts: ['screen'],
      props: {
        source: {
          description: 'Which feed this section renders.',
          values: ['topStories', 'forYou', 'following', 'continueReading', 'saved'],
        },
      },
      slots: {
        heading: { accepts: ['Text'], min: 0, max: 1, context: 'feed', childProps: { role: ['title', 'label'] } },
        content: { accepts: ['Collection'], min: 1, max: 1, context: 'feed' },
        footer: { accepts: ['Button'], min: 0, max: 1, context: 'feed' },
      },
    },

    Collection: {
      description: 'Repeater. Lays out feed items using an item template (and an optional lead template for the first item).',
      contexts: ['feed'],
      props: {
        layout: { values: ['stack', 'carousel', 'grid'] },
        limit: { description: 'Max items rendered.', values: ['3', '5', '10'] },
      },
      slots: {
        lead: {
          description: 'Template for the first item only. Stack layouts only.',
          accepts: ['Card'], min: 0, max: 1, context: 'article',
        },
        item: {
          description: 'Template applied to every (remaining) item.',
          accepts: ['Card'], min: 1, max: 1, context: 'article',
        },
      },
      constraints: [
        { when: { prop: 'layout', is: 'grid' }, childProps: { slot: 'item', prop: 'variant', in: ['standard'] } },
        { when: { prop: 'layout', is: 'carousel' }, childProps: { slot: 'item', prop: 'variant', in: ['hero', 'standard'] } },
        { when: { prop: 'layout', is: 'grid' }, forbidSlot: 'lead' },
        { when: { prop: 'layout', is: 'carousel' }, forbidSlot: 'lead' },
      ],
    },

    Card: {
      description: 'Renders one article. Tapping anywhere opens it.',
      contexts: ['article'],
      props: {
        variant: { values: ['hero', 'standard', 'compact'] },
      },
      slots: {
        media: { accepts: ['Image'], min: 0, max: 1 },
        title: { accepts: ['Text'], min: 1, max: 1, childProps: { role: ['title'] }, childContent: 'bind', childBind: ['title'] },
        meta: {
          accepts: ['Text'], min: 0, max: 2, distinct: true,
          childProps: { role: ['caption', 'label'] }, childContent: 'bind',
          childBind: ['source', 'author', 'publishedAt', 'readTime', 'topic'],
        },
        summary: { accepts: ['Text'], min: 0, max: 1, childProps: { role: ['body'] }, childContent: 'bind', childBind: ['dek'] },
        actions: { accepts: ['Button'], min: 0, max: 2, distinct: true },
      },
      constraints: [
        { when: { prop: 'variant', is: 'hero' }, requireSlot: 'media' },
        { when: { prop: 'variant', is: 'compact' }, forbidSlot: 'summary' },
        { when: { prop: 'variant', is: 'compact' }, childProps: { slot: 'media', prop: 'aspect', in: ['1:1'] } },
      ],
    },

    Text: {
      description: 'A run of text bound to a context field or a string key.',
      contexts: ['screen', 'feed', 'article'],
      props: {
        role: { values: ['title', 'body', 'caption', 'label'] },
        maxLines: { values: ['1', '2', '3'] },
      },
      content: { bind: ['text'], keys: true },
      constraints: [
        { when: { prop: 'role', is: 'caption' }, propIn: { prop: 'maxLines', in: ['1'] } },
        { when: { prop: 'role', is: 'label' }, propIn: { prop: 'maxLines', in: ['1'] } },
      ],
    },

    Image: {
      description: 'An image bound to a context field.',
      contexts: ['article'],
      props: {
        aspect: { values: ['16:9', '4:3', '1:1'] },
      },
      content: { bind: ['image'] },
    },

    Button: {
      description: 'An action. Its label and icon are derived from `action` by the renderer, so they are not choices.',
      contexts: ['screen', 'feed', 'article'],
      props: {
        action: {
          valuesByContext: {
            screen: ['refresh', 'search'],
            feed: ['seeMore'],
            article: ['read', 'save', 'share', 'follow', 'dismiss'],
          },
        },
        style: { values: ['primary', 'secondary', 'ghost'] },
      },
    },
  },
} as const satisfies Grammar;
