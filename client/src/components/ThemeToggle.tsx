import { useState } from 'react';
import { getTheme, toggleTheme } from '../theme';

export default function ThemeToggle() {
  const [theme, setTheme] = useState(getTheme());
  return (
    <button
      className="btn btn-ghost btn-sm"
      onClick={() => setTheme(toggleTheme())}
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label="Toggle color theme"
    >
      {theme === 'dark' ? '☀️' : '🌙'}
    </button>
  );
}
