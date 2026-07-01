// SPDX-License-Identifier: AGPL-3.0-or-later

interface PostMetrics {
  score: number;
  num_comments: number;
}

export function getEngagement(post: PostMetrics): number {
  return post.score + post.num_comments;
}
