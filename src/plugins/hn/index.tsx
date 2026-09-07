import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  ExternalLink,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  Zap,
} from "../../chrome/icons";
import type { Plugin, PluginHost } from "../registry";
import { flattenComments, type Comment } from "./comments";

const API = "https://hn.algolia.com/api/v1";
const LIST_URL = `${API}/search?tags=front_page&hitsPerPage=30`;
const COMMENTS_MAX = 60;

type Story = {
  objectID: string;
  title: string;
  url: string;
  points: number;
  numComments: number;
  author: string;
};

type Detail = { story: Story; comments: Comment[] };

function storyOf(raw: unknown): Story | null {
  if (typeof raw !== "object" || raw === null) return null;
  // JSON row from the Algolia API; every field is guarded before use.
  const row = raw as Record<string, unknown>;
  const id = typeof row.objectID === "string" ? row.objectID : "";
  const title = typeof row.title === "string" ? row.title.trim() : "";
  if (id.length === 0 || title.length === 0) return null;
  return {
    objectID: id,
    title,
    url: typeof row.url === "string" ? row.url : "",
    points: typeof row.points === "number" ? row.points : 0,
    numComments: typeof row.num_comments === "number" ? row.num_comments : 0,
    author: typeof row.author === "string" ? row.author : "",
  };
}

async function getJson(
  request: PluginHost["request"],
  url: string,
): Promise<unknown> {
  const response = await request({ method: "GET", url });
  if (response.status >= 400) {
    throw new Error(`HN responded with ${response.status}`);
  }
  try {
    return JSON.parse(response.body);
  } catch {
    throw new Error("HN responded with invalid JSON");
  }
}

function detailOf(raw: unknown): Detail | null {
  const story = storyOf(raw);
  if (!story) return null;
  const children =
    typeof raw === "object" && raw !== null && "children" in raw
      ? raw.children
      : null;
  return { story, comments: flattenComments(children, COMMENTS_MAX) };
}

const discussionUrl = (id: string) =>
  `https://news.ycombinator.com/item?id=${id}`;

/** Front page → story detail (with comments) → chat. */
function HnWorkspace({ addToChat, request }: PluginHost) {
  const [stories, setStories] = useState<Story[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);

  const loadList = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const raw: unknown = await getJson(request, LIST_URL);
      let hits: unknown[] = [];
      if (
        typeof raw === "object" &&
        raw !== null &&
        "hits" in raw &&
        Array.isArray(raw.hits)
      ) {
        hits = raw.hits;
      }
      setStories(hits.map(storyOf).filter((story) => story !== null));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [request]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const openStory = async (story: Story) => {
    setDetailBusy(true);
    setError(null);
    try {
      const raw: unknown = await getJson(
        request,
        `${API}/items/${story.objectID}`,
      );
      setDetail(detailOf(raw) ?? { story, comments: [] });
    } catch (cause) {
      setError(String(cause));
    } finally {
      setDetailBusy(false);
    }
  };

  const sendToChat = ({ story, comments }: Detail) => {
    const discussion = discussionUrl(story.objectID);
    const body = [
      story.title,
      story.url || discussion,
      ...(story.url ? [discussion] : []),
      "",
      `${story.points} points, ${story.numComments} comments, by ${story.author}`,
      ...comments
        .filter((comment) => comment.depth === 0)
        .slice(0, 3)
        .map(
          (comment) => `\n${comment.author}:\n${comment.text.slice(0, 300)}`,
        ),
    ].join("\n");
    addToChat(story.title, body);
  };

  if (detail) {
    const { story, comments } = detail;
    const discussion = discussionUrl(story.objectID);
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-content/10 px-2 py-1.5">
          <button
            type="button"
            onClick={() => setDetail(null)}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-content/60 hover:bg-content/10 hover:text-content"
          >
            <ArrowLeft className="size-3.5" strokeWidth={1.75} />
            Front page
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <h2 className="text-[15px] font-medium leading-snug text-content">
            {story.title}
          </h2>
          <p className="mt-1 text-[12px] text-content/45">
            {story.points} points · {story.numComments} comments · by{" "}
            {story.author}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => sendToChat(detail)}
              className="flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-[12px] font-medium text-white hover:opacity-90"
            >
              <MessageSquare className="size-3.5" strokeWidth={1.75} />
              Add to chat
            </button>
            {story.url.length > 0 ? (
              <button
                type="button"
                onClick={() => void openUrl(story.url)}
                className="flex items-center gap-1.5 rounded-md border border-content/10 px-2.5 py-1.5 text-[12px] hover:bg-content/10"
              >
                <ExternalLink className="size-3.5" strokeWidth={1.75} />
                Article
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void openUrl(discussion)}
              className="flex items-center gap-1.5 rounded-md border border-content/10 px-2.5 py-1.5 text-[12px] hover:bg-content/10"
            >
              <Zap className="size-3.5" strokeWidth={1.75} />
              Discussion
            </button>
          </div>

          {comments.length > 0 ? (
            <div className="mt-4 flex flex-col gap-2">
              {comments.map((comment, index) => (
                <div
                  key={index}
                  className="rounded-md border border-content/10 bg-content/6 p-2"
                  style={{ marginLeft: comment.depth * 14 }}
                >
                  <p className="text-[11px] font-medium text-content/50">
                    {comment.author}
                  </p>
                  <p className="mt-0.5 whitespace-pre-wrap text-[12px] leading-snug text-content/80">
                    {comment.text}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-[12px] text-content/45">No comments.</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-content/10 px-3 py-2 text-[12px] text-content/50">
        <button
          type="button"
          onClick={() => void loadList()}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-content/10 hover:text-content disabled:opacity-40"
        >
          {busy ? (
            <LoaderCircle
              className="size-3.5 animate-spin"
              strokeWidth={1.75}
            />
          ) : (
            <RefreshCw className="size-3.5" strokeWidth={1.75} />
          )}
          Refresh
        </button>
        {stories ? <span>{stories.length} stories</span> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error ? (
          <p className="rounded-md border border-content/10 bg-content/6 p-2 text-[12px] text-content/70">
            {error}
          </p>
        ) : null}
        {stories ? (
          <div className="flex flex-col gap-1">
            {stories.map((story) => (
              <button
                key={story.objectID}
                type="button"
                onClick={() => void openStory(story)}
                className="flex flex-col items-start gap-0.5 rounded-md border border-content/10 px-3 py-2 text-left hover:bg-content/10"
              >
                <span className="w-full text-[13px] font-medium leading-snug text-content">
                  {story.title}
                </span>
                <span className="text-[12px] text-content/45">
                  {story.points} points · {story.numComments} comments ·{" "}
                  {story.author}
                </span>
              </button>
            ))}
          </div>
        ) : !error ? (
          <div className="flex justify-center p-8">
            <LoaderCircle
              className="size-4 animate-spin text-content/40"
              strokeWidth={1.75}
            />
          </div>
        ) : null}
      </div>
      {detailBusy ? (
        <div className="flex shrink-0 items-center justify-center gap-2 border-t border-content/10 py-2 text-[12px] text-content/50">
          <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.75} />
          Loading discussion…
        </div>
      ) : null}
    </div>
  );
}

const plugin: Plugin = {
  id: "hn",
  label: "Hacker News",
  icon: Zap,
  Workspace: HnWorkspace,
};

export default plugin;
