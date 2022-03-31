import { Link, json, useLoaderData, useLocation, useSearchParams } from 'remix';
import InfiniteScroll from 'react-infinite-scroll-component';
import type { LoaderFunction } from 'remix';
import invariant from 'tiny-invariant';
import { useRef } from 'react';

import {
  DEFAULT_TWEETS_FILTER,
  DEFAULT_TWEETS_LIMIT,
  DEFAULT_TWEETS_SORT,
  TweetsFilter,
  TweetsSort,
} from '~/query';
import { commitSession, getSession } from '~/session.server';
import { getClusterTweets, getListTweets, getRektTweets } from '~/query.server';
import { log, nanoid } from '~/utils.server';
import BoltIcon from '~/icons/bolt';
import CloseIcon from '~/icons/close';
import Column from '~/components/column';
import Empty from '~/components/empty';
import FilterIcon from '~/icons/filter';
import Header from '~/components/header';
import SortIcon from '~/icons/sort';
import Switcher from '~/components/switcher';
import { TimeAgo } from '~/components/timeago';
import type { TweetFull } from '~/types';
import TweetItem from '~/components/tweet';
import { useError } from '~/error';

export type LoaderData = TweetFull[];

// $src - the type of source (e.g. clusters or lists).
// $id - the id of a specific source (e.g. a cluster slug or user list id).
export const loader: LoaderFunction = async ({ params, request }) => {
  const invocationId = nanoid(5);
  console.time(`src-id-loader-${invocationId}`);
  invariant(params.src, 'expected params.src');
  invariant(params.id, 'expected params.id');
  log.info(`Fetching tweets for ${params.src} (${params.id})...`);
  const url = new URL(request.url);
  const session = await getSession(request.headers.get('Cookie'));
  const uid = session.get('uid') as string | undefined;
  session.set('href', `${url.pathname}${url.search}`);
  const sort = Number(
    url.searchParams.get('s') ?? DEFAULT_TWEETS_SORT
  ) as TweetsSort;
  const filter = Number(
    url.searchParams.get('f') ?? DEFAULT_TWEETS_FILTER
  ) as TweetsFilter;
  const limit = Number(url.searchParams.get('l') ?? DEFAULT_TWEETS_LIMIT);
  let tweetsPromise: Promise<TweetFull[]>;
  switch (params.src) {
    case 'clusters':
      tweetsPromise = getClusterTweets(params.id, sort, filter, limit, uid);
      break;
    case 'lists':
      tweetsPromise = getListTweets(params.id, sort, filter, limit, uid);
      break;
    case 'rekt':
      tweetsPromise = getRektTweets(sort, filter, limit, uid);
      break;
    default:
      throw new Response('Not Found', { status: 404 });
  }
  let tweets: TweetFull[] = [];
  await Promise.all([
    (async () => {
      console.time(`swr-get-tweets-${invocationId}`);
      tweets = await tweetsPromise;
      console.timeEnd(`swr-get-tweets-${invocationId}`);
    })(),
  ]);
  console.timeEnd(`src-id-loader-${invocationId}`);
  const headers = { 'Set-Cookie': await commitSession(session) };
  return json<LoaderData>(tweets, { headers });
};

export function ErrorBoundary({ error }: { error: Error }) {
  useError(error);
  const tweetsRef = useRef<HTMLElement>(null);
  return (
    <section
      ref={tweetsRef}
      className='flex-none w-[32rem] flex flex-col border-r border-gray-200 dark:border-gray-800 overflow-y-scroll'
    >
      <Header scrollerRef={tweetsRef} header='Tweets' />
      <Empty className='flex-1 m-5'>
        <p>An unexpected runtime error occurred:</p>
        <p>{error.message}</p>
        <p className='mt-2'>
          Try logging out and in again. Or smash your keyboard; that sometimes
          helps. If you still have trouble, come and complain in{' '}
          <a
            className='underline'
            href='https://discord.gg/3KYQBJwRSS'
            target='_blank'
            rel='noopener noreferrer'
          >
            our Discord server
          </a>
          ; we’re always more than happy to help.
        </p>
      </Empty>
    </section>
  );
}

export default function TweetsPage() {
  const tweets = useLoaderData<LoaderData>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { pathname } = useLocation();
  return (
    <Column className='max-w-xl border-x border-gray-200 dark:border-gray-800'>
      <nav className='sticky top-0 z-10 bg-white/75 dark:bg-gray-900/75 backdrop-blur-sm p-1.5 flex items-stretch border-b border-gray-200 dark:border-gray-800'>
        <Link
          to={pathname.replaceAll('/tweets', '')}
          className='mr-1.5 flex truncate items-center text-xs bg-gray-200 dark:bg-gray-700 rounded px-2 h-6'
        >
          <CloseIcon className='shrink-0 w-3.5 h-3.5 mr-1 fill-gray-500' />
          <span>Close</span>
        </Link>
        <div className='mr-1.5 flex truncate items-center text-xs bg-gray-200 dark:bg-gray-700 rounded px-2 h-6'>
          <BoltIcon />
          <span>
            Synced <TimeAgo datetime={new Date()} locale='en_short' />
          </span>
        </div>
        <Switcher
          icon={<SortIcon className='fill-current h-4 w-4 mr-1 inline-block' />}
          sections={[
            {
              header: 'Sort by',
              links: [
                {
                  name: 'Tweet count',
                  to: `?s=${TweetsSort.TweetCount}`,
                },
                {
                  name: 'Retweet count',
                  to: `?s=${TweetsSort.RetweetCount}`,
                },
                {
                  name: 'Quote count',
                  to: `?s=${TweetsSort.QuoteCount}`,
                },
                {
                  name: 'Like count',
                  to: `?s=${TweetsSort.LikeCount}`,
                },
                {
                  name: 'Follower count',
                  to: `?s=${TweetsSort.FollowerCount}`,
                },
                {
                  name: 'Latest first',
                  to: `?s=${TweetsSort.Latest}`,
                  isActiveByDefault: true,
                },
                {
                  name: 'Earliest first',
                  to: `?s=${TweetsSort.Earliest}`,
                },
              ],
            },
          ]}
        />
        <Switcher
          icon={
            <FilterIcon className='fill-current h-4 w-4 mr-1 inline-block' />
          }
          sections={[
            {
              header: 'Filter',
              links: [
                {
                  name: 'Hide retweets',
                  to: `?f=${TweetsFilter.HideRetweets}`,
                },
                {
                  name: 'Show retweets',
                  to: `?f=${TweetsFilter.ShowRetweets}`,
                  isActiveByDefault: true,
                },
              ],
            },
          ]}
        />
      </nav>
      {!tweets.length && (
        <Empty className='flex-1 m-5'>No tweets to show</Empty>
      )}
      {!!tweets.length && (
        <ol>
          <InfiniteScroll
            dataLength={tweets.length}
            next={() =>
              setSearchParams({
                ...Object.fromEntries(searchParams.entries()),
                l: (Number(searchParams.get('l') ?? 50) + 50).toString(),
              })
            }
            loader={Array(3)
              .fill(null)
              .map((_, idx) => (
                <TweetItem key={idx} />
              ))}
            scrollThreshold={0.65}
            scrollableTarget='tweets'
            style={{ overflow: 'hidden' }}
            hasMore
          >
            {tweets.map((tweet) => (
              <TweetItem tweet={tweet} key={tweet.id} />
            ))}
          </InfiniteScroll>
        </ol>
      )}
    </Column>
  );
}
