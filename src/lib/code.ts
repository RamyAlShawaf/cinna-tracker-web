const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';

export function generatePublicCode(): string {
  // Format like ONX-102 style: XXX-999
  const letters = () => Array.from({ length: 3 }, () => alphabet[Math.floor(Math.random() * 23)]).join('');
  const numbers = () => String(Math.floor(Math.random() * 900) + 100);
  return `${letters()}-${numbers()}`;
}


