import type { Config } from 'tailwindcss';
import tailwindcssAnimate from 'tailwindcss-animate';
import { fontFamily } from 'tailwindcss/defaultTheme';

/* The semantic color contract reads the shadcn variables that src/app.css maps
   onto the Antasphere brand tokens (the Exos pattern). `muted` and `accent`
   read the --tpl- renamed pair (the bare names belong to the brand). Radii
   follow the brand's ramp (7 / 12, buttons 16); the default sans is Onest,
   the display Sentient. */
const config: Config = {
  darkMode: ['class'],
  content: ['./src/**/*.{html,js,svelte,ts}'],
  safelist: ['dark'],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: {
        '2xl': '1250px'
      }
    },
    extend: {
      colors: {
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
          foreground: 'hsl(var(--primary-foreground) / <alpha-value>)'
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary) / <alpha-value>)',
          foreground: 'hsl(var(--secondary-foreground) / <alpha-value>)'
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
          foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)'
        },
        muted: {
          DEFAULT: 'hsl(var(--tpl-muted) / <alpha-value>)',
          foreground: 'hsl(var(--muted-foreground) / <alpha-value>)'
        },
        accent: {
          DEFAULT: 'hsl(var(--tpl-accent) / <alpha-value>)',
          foreground: 'hsl(var(--accent-foreground) / <alpha-value>)'
        },
        popover: {
          DEFAULT: 'hsl(var(--popover) / <alpha-value>)',
          foreground: 'hsl(var(--popover-foreground) / <alpha-value>)'
        },
        card: {
          DEFAULT: 'hsl(var(--card) / <alpha-value>)',
          foreground: 'hsl(var(--card-foreground) / <alpha-value>)'
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar-background))',
          foreground: 'hsl(var(--sidebar-foreground))',
          primary: 'hsl(var(--sidebar-primary))',
          'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
          accent: 'hsl(var(--sidebar-accent))',
          'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
          border: 'hsl(var(--sidebar-border))',
          ring: 'hsl(var(--sidebar-ring))'
        },
        'button-hover': 'hsl(var(--button-hover) / <alpha-value>)',
        'button-hover-foreground': 'hsl(var(--button-hover-foreground) / <alpha-value>)',
        /* the brand tokens as utilities, for the odd inline case */
        ground: {
          DEFAULT: 'var(--ground)',
          2: 'var(--ground-2)',
          3: 'var(--ground-3)'
        },
        ink: {
          DEFAULT: 'var(--ink)',
          soft: 'var(--ink-soft)'
        },
        hairline: 'var(--hairline)',
        brand: {
          muted: 'var(--muted)',
          accent: 'var(--accent)',
          'accent-ink': 'var(--accent-ink)',
          'accent-soft': 'var(--accent-soft)',
          ok: 'var(--ok)',
          'ok-soft': 'var(--ok-soft)',
          warn: 'var(--warn)',
          'warn-soft': 'var(--warn-soft)',
          danger: 'var(--danger)',
          'danger-soft': 'var(--danger-soft)'
        }
      },
      borderRadius: {
        '2xl': '16px',
        xl: 'var(--r-lg)',
        lg: '9px',
        md: 'var(--r)',
        sm: '5px',
        btn: 'var(--r-btn)'
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)'
      },
      fontFamily: {
        sans: ['Onest', ...fontFamily.sans],
        display: ['Sentient', ...fontFamily.serif],
        second: ['Synonym', ...fontFamily.sans]
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--bits-accordion-content-height)' }
        },
        'accordion-up': {
          from: { height: 'var(--bits-accordion-content-height)' },
          to: { height: '0' }
        },
        'caret-blink': {
          '0%,70%,100%': { opacity: '1' },
          '20%,50%': { opacity: '0' }
        }
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'caret-blink': 'caret-blink 1.25s ease-out infinite'
      }
    }
  },
  plugins: [tailwindcssAnimate]
};

export default config;
