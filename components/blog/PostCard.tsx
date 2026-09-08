import { siteConfig } from "@/config/site.config";
import { formatDate, type PostMeta } from "@/lib/blog/posts";

/** One row in the index: title, date, description. Nothing niche-specific lives here. */
export function PostCard({ post }: { post: PostMeta }) {
  return (
    <article>
      <h2>
        <a href={`/blog/${post.slug}`}>{post.title}</a>
      </h2>
      <p>
        <time dateTime={post.date}>{formatDate(post.date, siteConfig.locale)}</time>
      </p>
      {post.description === "" ? null : <p>{post.description}</p>}
    </article>
  );
}
