export type Visibility = 'public' | 'private';

export type Confidence = 'confirmed' | 'reproduced' | 'tentative';

export type Outcome = 'resolved' | 'impossible';

export type Source = 'own' | `community/${string}`;

export type Environment = Record<string, string>;

export interface Frontmatter {
  id: string;
  title: string;
  visibility: Visibility;
  confidence: Confidence;
  outcome?: Outcome;
  tags: string[];
  environment: Environment;
  source_project: string | null;
  source_session: string;
  created_at: string;
  updated_at: string;
  last_verified?: string;
  brief_id?: string;
}

export interface SearchResult {
  id: string;
  source: Source;
  title: string;
  symptomExcerpt: string;
  confidence: Confidence;
  environment: Environment;
}

export interface SearchFilters {
  tags?: string[];
  confidence?: Confidence[];
  source?: 'own' | 'community' | 'all';
  env?: Environment;
}

export interface GetResult {
  id: string;
  source: Source;
  path: string;
  frontmatter: Frontmatter;
  sections: Record<string, string>;
  body: string;
}

export interface CoreConfig {
  knowledgeRepo: string;
  semverKeys: string[];
  communitySources: string[];
  sharedRepo: string;
}
