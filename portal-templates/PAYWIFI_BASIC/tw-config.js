/* Tailwind runtime config — maps utility classes to CSS variables defined
 * in /app.css. Loaded right after /tailwind.js so the config is in place
 * before Tailwind generates any styles.
 */
tailwind.config = {
  darkMode: ["class"],
  theme: {
    extend: {
      colors: {
        background:               "var(--background)",
        foreground:               "var(--foreground)",
        card:                     "var(--card)",
        "card-foreground":        "var(--card-foreground)",
        popover:                  "var(--popover)",
        "popover-foreground":     "var(--popover-foreground)",
        primary:                  "var(--primary)",
        "primary-foreground":     "var(--primary-foreground)",
        secondary:                "var(--secondary)",
        "secondary-foreground":   "var(--secondary-foreground)",
        muted:                    "var(--muted)",
        "muted-foreground":       "var(--muted-foreground)",
        accent:                   "var(--accent)",
        "accent-foreground":      "var(--accent-foreground)",
        destructive:              "var(--destructive)",
        "destructive-foreground": "var(--destructive-foreground)",
        success:                  "var(--success)",
        "success-foreground":     "var(--success-foreground)",
        border:                   "var(--border)",
        input:                    "var(--input)",
        ring:                     "var(--ring)",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
};
