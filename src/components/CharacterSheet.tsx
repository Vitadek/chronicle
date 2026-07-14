import React, { useState } from 'react';
import { ChevronLeft, Trash2, User } from 'lucide-react';
import { cn } from '../lib/utils';
import { Character } from '../types';

interface CharacterSheetProps {
  character: Character;
  isDarkMode: boolean;
  onUpdate: (patch: Partial<Character>) => void;
  onDelete: () => void;
  onBack: () => void;
}

/**
 * Full character sheet, modelled on the LSnarrative Character Map (v2.1).
 *
 * Layout:
 *   - Header with name (required) + colour swatch
 *   - Core Urge group (stated belief, origin, what it drives)
 *   - "Affects all areas of their life" grid (goals / relationships /
 *      lifestyle / presentation / dialogue)
 *   - More Attributes (mood, hobbies, skills, habits, tastes, weaknesses)
 *   - Character Arc (at first, later, what challenges/reinforces, outcome)
 *
 * Every field is optional except name. The structure mirrors the worksheet
 * but each section is collapsed by default so a new character can be
 * added in three keystrokes (open / type name / save).
 */

const PALETTE = [
  '#5B8DEF', '#E07A5F', '#8AA47B', '#C8A2C8', '#F4A261',
  '#2A9D8F', '#E9C46A', '#9C6644', '#577590', '#D5896F',
];

export const CharacterSheet: React.FC<CharacterSheetProps> = ({
  character,
  isDarkMode,
  onUpdate,
  onDelete,
  onBack,
}) => {
  const [confirmDelete, setConfirmDelete] = useState(false);

  const labelClass = 'block text-[10px] uppercase tracking-widest font-bold opacity-30 mb-2';
  const inputClass = cn(
    'w-full px-4 py-3 rounded-xl text-xs bg-black/[0.03] dark:bg-white/[0.08] border border-black/12 dark:border-white/15 focus:border-black/10 dark:focus:border-white/20 outline-none transition-all',
    isDarkMode ? 'text-white' : 'text-black',
  );
  const textareaClass = cn(inputClass, 'resize-none min-h-[60px]');

  const field = <K extends keyof Character>(
    key: K,
    label: string,
    placeholder?: string,
    multiline?: boolean,
  ) => {
    return (
      <div>
        <label className={labelClass}>{label}</label>
        {multiline ? (
          <textarea
            value={(character[key] as string) || ''}
            onChange={(e) => onUpdate({ [key]: e.target.value } as Partial<Character>)}
            placeholder={placeholder}
            rows={3}
            className={textareaClass}
          />
        ) : (
          <input
            type="text"
            value={(character[key] as string) || ''}
          onChange={(e) => onUpdate({ [key]: e.target.value } as Partial<Character>)}
          placeholder={placeholder}
          className={inputClass}
        />
      )}
    </div>
    );
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Header bar with back arrow + delete */}
      <div className="flex items-center justify-between px-2 pb-3 border-b border-current/5">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors opacity-60 hover:opacity-100"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
          <span className="text-[10px] uppercase tracking-widest font-bold">Back</span>
        </button>
        {confirmDelete ? (
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => {
                onDelete();
                setConfirmDelete(false);
              }}
              className="px-3 py-1.5 bg-red-500 text-white text-[10px] font-bold uppercase tracking-widest rounded-lg hover:bg-red-600 transition-colors"
            >
              Delete
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold opacity-60 hover:opacity-100 transition-opacity"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="p-1.5 rounded-lg hover:bg-red-500/10 hover:text-red-500 transition-all opacity-40 hover:opacity-100"
            title="Delete character"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto space-y-6 pr-1 mt-4 pb-4">
        {/* Name + colour */}
        <section className="px-2 space-y-3">
          <div className="flex items-start gap-3">
            <div
              className="w-12 h-12 rounded-2xl shrink-0 flex items-center justify-center"
              style={{ backgroundColor: character.color || PALETTE[0] }}
            >
              <User className="w-5 h-5 text-white/90" />
            </div>
            <div className="flex-1">
              <label className={labelClass}>Name</label>
              <input
                type="text"
                value={character.name}
                onChange={(e) => onUpdate({ name: e.target.value })}
                placeholder="Character name"
                className={inputClass}
              />
            </div>
          </div>
          <div>
            <label className={labelClass}>Lane Colour</label>
            <div className="flex flex-wrap gap-1.5">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  onClick={() => onUpdate({ color: c })}
                  className={cn(
                    'w-6 h-6 rounded-full transition-all',
                    character.color === c ? 'ring-2 ring-offset-2 ring-current scale-110' : 'opacity-70 hover:opacity-100',
                  )}
                  style={{ backgroundColor: c }}
                  title={c}
                />
              ))}
            </div>
          </div>
        </section>

        {/* Core Urge */}
        <section className="px-2 space-y-3">
          <h3 className="text-[10px] uppercase tracking-[0.2em] font-bold opacity-40">Core Urge</h3>
          <p className="text-[9px] opacity-30 leading-relaxed">
            A compulsion. "In order to survive / get my needs met, I must..."
          </p>
          {field('coreUrge', 'Core Urge', 'e.g. control everything', true)}
          {field('statedBelief', 'Stated Belief (Lie)', 'The narrative they tell themselves to justify the urge.', true)}
          {field('originOfUrge', 'Origin (optional)', 'When did they learn to behave this way? How did it help them?', true)}
        </section>

        {/* Affects all areas */}
        <section className="px-2 space-y-3">
          <h3 className="text-[10px] uppercase tracking-[0.2em] font-bold opacity-40">The Core Urge Affects…</h3>
          {field('goals', 'Goals', '', true)}
          {field('relationships', 'Relationships', '', true)}
          {field('lifestyle', 'Lifestyle', '', true)}
          {field('presentation', 'Presentation', 'How they dress, carry themselves, etc.', true)}
          {field('dialogue', 'Dialogue', 'Speech patterns, common phrases, what they avoid saying.', true)}
        </section>

        {/* More attributes */}
        <section className="px-2 space-y-3">
          <h3 className="text-[10px] uppercase tracking-[0.2em] font-bold opacity-40">More Attributes</h3>
          <p className="text-[9px] opacity-30 leading-relaxed">
            These can reflect the core urge, but don't have to.
          </p>
          {field('moodTemperament', 'Mood / Temperament', '', true)}
          {field('hobbies', 'Hobbies', '', true)}
          {field('skills', 'Skills', '', true)}
          {field('habitsAddictions', 'Habits / Addictions', '', true)}
          {field('tastesPreferences', 'Tastes / Preferences', '', true)}
          {field('weaknesses', 'Weaknesses', 'How could someone trick or manipulate this character?', true)}
        </section>

        {/* Arc */}
        <section className="px-2 space-y-3">
          <h3 className="text-[10px] uppercase tracking-[0.2em] font-bold opacity-40">Character Arc</h3>
          {field('arcAtFirst', 'At First…', '', true)}
          {field('arcLater', 'Later On…', '', true)}
          {field('arcChallenges', 'What Challenges the Core Urge?', '', true)}
          {field('arcReinforces', 'What Reinforces the Core Urge?', '', true)}

          <div>
            <label className={labelClass}>Do They Overcome Their Core Urge?</label>
            <div className="grid grid-cols-3 gap-2">
              {([
                { value: 'yes', label: 'Yes' },
                { value: 'no', label: 'No' },
                { value: 'worse', label: 'Even worse' },
              ] as const).map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => onUpdate({ arcOutcome: opt.value })}
                  className={cn(
                    'px-3 py-2 rounded-lg text-[10px] uppercase tracking-widest font-bold transition-all border',
                    character.arcOutcome === opt.value
                      ? (isDarkMode ? 'bg-white/10 border-white/20 text-white' : 'bg-black/5 border-black/10 text-black')
                      : 'border-transparent opacity-50 hover:opacity-100',
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {character.arcOutcome && (
            <div className="space-y-3 pt-1">
              <p className="text-[9px] opacity-30 leading-relaxed px-1">
                If applicable, what changes about their…
              </p>
              {field('arcChangesGoals', 'Goals (after)', '', true)}
              {field('arcChangesRelationships', 'Relationships (after)', '', true)}
              {field('arcChangesLifestyle', 'Lifestyle (after)', '', true)}
              {field('arcChangesPresentation', 'Presentation (after)', '', true)}
              {field('arcChangesDialogue', 'Dialogue (after)', '', true)}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export const DEFAULT_CHARACTER_PALETTE = PALETTE;
