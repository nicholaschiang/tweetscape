import fs from 'fs/promises';
import path from 'path';

import { HTMLRewriter } from '@miniflare/html-rewriter';

import { caps, decode, fetchFromCache, log } from './utils.mjs';

const HIVE_TOKEN = 'c23ace1f-c6ab-4d4e-b253-73dfc0fdc21d';
const TWITTER_TOKEN =
  'AAAAAAAAAAAAAAAAAAAAAKR4ZgEAAAAAUqVKjSn2duWccIKmB6OqyLVu%2B2o%3D6iIomCUAad4SPTCNcvNVCxOOxDWtg3zJiktr09jfdoemPqvf3y';

async function getInfluencers(t, pg = 0) {
  log.debug(`Fetching influencers for topic (${t})...`);
  const res = await fetchFromCache(
    `https://api.borg.id/influence/clusters/${caps(t)}/influencers?` +
      `page=${pg}&sort_by=score&sort_direction=desc&influence_type=all`,
    { headers: { authorization: `Token ${HIVE_TOKEN}` } }
  );
  const headers = Object.fromEntries(res.headers.entries());
  log.trace(`Headers: ${JSON.stringify(headers, null, 2)}`);
  const data = await res.json();
  return data;
}

async function getTweets(id, token = '', tweets = []) {
  log.debug(`Fetching tweets for influencer (${id})...`);
  const res = await fetchFromCache(
    `https://api.twitter.com/2/users/${id}/tweets?` +
      `tweet.fields=created_at,entities,author_id,public_metrics,referenced_tweets&` +
      `expansions=referenced_tweets.id,referenced_tweets.id.author_id&` +
      `max_results=100${token ? `&pagination_token=${token}` : ''}`,
    { headers: { authorization: `Bearer ${TWITTER_TOKEN}` } }
  );
  const headers = Object.fromEntries(res.headers.entries());
  log.trace(`Headers: ${JSON.stringify(headers, null, 2)}`);
  const data = await res.json();
  if (data.errors && data.title && data.detail && data.type)
    log.error(`${data.title}: ${data.detail} (${data.type})`);
  tweets.push(data);
  if (!data.meta?.next_token) return tweets;
  return getTweets(id, data.meta.next_token, tweets);
}

async function getArticle(url, tweets) {
  log.debug(`Fetching metadata for link (${url})...`);
  const article = {
    url,
    tweets,
    title: `${decode(url.replace(/^https?:\/\/(www\.)?/, '').substr(0, 50))}…`,
    description:
      'No appropriate description meta tag found in article html; perhaps' +
      ' they did something weird like put their tag names in all caps 🤷.',
    // TODO: Perhaps show the most recent share or the first share or the date
    // the article or content link was actually published (use metascraper).
    domain: new URL(url).hostname.replace(/^www\./, ''),
  };
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetchFromCache(url, {
      signal: controller.signal,
    });
    const headers = Object.fromEntries(res.headers.entries());
    log.trace(`Headers (${url}): ${JSON.stringify(headers, null, 2)}`);
    clearTimeout(timeoutId);
    let title = '';
    let description = '';
    await new HTMLRewriter()
      .on('meta', {
        element(el) {
          const content = el.getAttribute('content');
          if (content && el.getAttribute('property') === 'og:description')
            description = content;
          if (content && el.getAttribute('name') === 'description')
            description = content;
          if (content && el.getAttribute('property') === 'og:title')
            title = content;
        },
      })
      .on('title', {
        text(txt) {
          title += txt.text;
        },
      })
      .transform(res)
      .text();
    article.title = decode(title) || article.title;
    article.description = decode(description) || article.description;
  } catch (e) {
    log.error(`Error fetching link (${url}): ${e.message}`);
  }
  return article;
}

function isArticleURL(l) {
  return !!l && !!l.expanded_url && !/twitter.com/.test(l.expanded_url);
}

async function fast(topic) {
  const articles = [];
  const { total, ...data } = await getInfluencers(topic, 0);
  // 1. Fetch all 12989 influencers from Hive in parallel (pages of 100).
  log.info(`Fetching ${total} influencers from Hive (in pages of 100)...`);
  const arr = Array(Math.ceil(Number(total) / 50)).fill(null);
  await Promise.all(
    arr.map(async (_, pg) => {
      const { influencers } = pg === 0 ? data : await getInfluencers(topic, pg);
      // 2. Fetch all 3200 tweets from each of those influencers' timelines in
      // parallel (recurse 32 times to get all 3200).
      log.info(
        `Fetching 3200 tweets from ${influencers.length} timelines (${pg})...`
      );
      await Promise.all(
        influencers.map(async (i) => {
          const tweets = await getTweets(i.social_account.social_account.id);
          await Promise.all(
            tweets
              .reduce((a, b) => [...a, ...(b.data ?? [])], [])
              .filter((t) => t.entities?.urls?.some(isArticleURL))
              .map(async (t) => {
                // 3. From those tweets (as they come in), construct articles.
                if (i.social_account.social_account.id !== t.author_id)
                  throw new Error(
                    `Tweet (${t.id}) author (${t.author_id}) invalid`
                  );
                const url =
                  t.entities?.urls?.filter(isArticleURL)[0].expanded_url;
                const exists = articles.find((a) => a.url === url);
                // 4. As articles come in, fetch their metadata asynchronously.
                const article = exists ?? (await getArticle(url, []));
                // TODO: Recursively count each referenced original tweet.
                article.tweets.push(t);
                if (!exists) articles.push(article);
              })
          );
        })
      );
    })
  );
  // 5. Store the article database as a JSON file.
  const filename = path.resolve(__dirname, 'articles.json');
  log.info(`Storing articles database as JSON file (${filename})...`);
  await fs.writeFile(filename, JSON.stringify(articles, null, 2));
}

void fast('tesla');