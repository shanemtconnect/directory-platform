import { siteConfig } from "@/config/site.config";
import { formatDate, type PostMeta } from "@/lib/blog/posts";

/** One row in the index: title, date, description. Nothing niche-specific lives here. */
export function PostCard({ post }: { post: PostMeta }) {
  return (
    <article className="card card-hover">
      <h2 className="mt-0 mb-1">
        <a
          href={`/blog/${post.slug}`}
          className="text-ink no-underline hover:text-primary hover:underline"
        >
          {post.title}
        </a>
      </h2>
      <p className="mb-0 text-sm text-muted">
        <time dateTime={post.date}>{formatDate(post.date, siteConfig.locale)}</time>
      </p>
      {post.description === "" ? null : (
        <p className="mt-2 mb-0 text-muted">{post.description}</p>
      )}
    </article>
  );
}
