export interface UserProfile {
  name: string;
  address: string;
  phone: string;
  email: string;
  agentInfo?: string;
}

export interface PluginStateRecord {
  id: string;
  pluginId: string;
  manuscriptId: string | null;
  enabled: boolean;
  state: string; // JSON string
  lastModified: number;
}

export interface Chapter {
  id: string;
  title: string;
  content: string;
  lastModified: number;
}

export interface ManuscriptMetadata {
  id: string;
  title: string;
  author: string;
  lastModified: number;
  sceneBreakStyle?: 'classic' | 'dots' | 'ornamental' | 'custom';
  customSceneBreakSvg?: string;
  contactName?: string;
  contactAddress?: string;
  contactPhone?: string;
  contactEmail?: string;
  agentInfo?: string;
  genre?: string;
  wordCount?: number;
  synopsis?: string;
  /**
   * Cover art reference. Set after the client uploads to /api/covers and
   * the server returns the stored filename. The image itself is served
   * back at /api/covers/<filename>.
   */
  coverArt?: string;
}

export interface Manuscript {
  metadata: ManuscriptMetadata;
  chapters: Chapter[];
  characters?: Character[];
  plotNodes?: PlotNode[];
  plotEdges?: PlotEdge[];
}

/**
 * Character sheet following the LSnarrative Character Map framework.
 * The only required field is `name` so the user can add a character to
 * the plot canvas in one click and fill in the rest later.
 */
export interface Character {
  id: string;
  name: string;
  lastModified: number;
  /** Hex color for the character's lane on the plot canvas + label. */
  color?: string;
  // ---- Core Urge ----
  coreUrge?: string;
  originOfUrge?: string;
  statedBelief?: string;
  // ---- How the urge affects life ----
  goals?: string;
  relationships?: string;
  lifestyle?: string;
  presentation?: string;
  dialogue?: string;
  // ---- More attributes ----
  moodTemperament?: string;
  hobbies?: string;
  skills?: string;
  habitsAddictions?: string;
  tastesPreferences?: string;
  weaknesses?: string;
  // ---- Arc ----
  arcAtFirst?: string;
  arcLater?: string;
  arcChallenges?: string;
  arcReinforces?: string;
  arcOutcome?: 'yes' | 'no' | 'worse' | '';
  arcChangesGoals?: string;
  arcChangesRelationships?: string;
  arcChangesLifestyle?: string;
  arcChangesPresentation?: string;
  arcChangesDialogue?: string;
}

/**
 * A node on the plot canvas. Either a scene/event or a comment sticky.
 *
 *  - Event nodes connect via PlotEdges to show story flow.
 *  - Comment nodes are loose stickies for notes that don't fit the timeline.
 *  - Position is in canvas pixel space; the canvas component handles zoom.
 */
export interface PlotNode {
  id: string;
  type: 'event' | 'comment';
  title: string;
  description?: string;
  /** Character IDs involved in this event (empty for comment notes). */
  characterIds?: string[];
  /** Canvas-space coordinates. */
  x: number;
  y: number;
  lastModified: number;
}

/**
 * A directed connection between two PlotNodes, showing how story beats
 * lead to each other.
 */
export interface PlotEdge {
  id: string;
  from: string; // PlotNode.id
  to: string;   // PlotNode.id
  label?: string;
  lastModified: number;
}
