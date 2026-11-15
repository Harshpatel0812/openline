export type HelpCategoryId =
  | "getting-started"
  | "contacts"
  | "mailboxes"
  | "sequences"
  | "replies"
  | "scout"
  | "compliance"
  | "deliverability";

export interface HelpArticle {
  slug: string;
  category: HelpCategoryId;
  title: string;
  summary: string;
  /** ISO date the article was last checked against the product. */
  updated: string;
  body: string;
}
