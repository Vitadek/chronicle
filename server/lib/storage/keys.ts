/** Map stable local blob keys to the versioned, provider-neutral replica layout. */
export function portableReplicaKey(key: string): string {
  if (key.startsWith('v1/')) return key;

  const [namespace, userId, ...rest] = key.split('/');
  if (!userId) return key;

  if (namespace === 'covers' && rest.length) {
    return `v1/users/${userId}/covers/${rest.join('/')}`;
  }
  if (namespace === 'settings' && rest.length === 0) {
    return `v1/users/${userId}/settings.json`;
  }
  if (namespace === 'profiles' && rest.length === 0) {
    return `v1/users/${userId}/profile.json`;
  }
  if (namespace === 'manuscripts' && rest.length) {
    const mapped = [...rest];
    if (mapped.at(-1) === 'manuscript.json') mapped[mapped.length - 1] = 'metadata.json';
    return `v1/users/${userId}/manuscripts/${mapped.join('/')}`;
  }

  return key;
}
