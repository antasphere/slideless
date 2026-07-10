import type { Config } from 'tailwindcss';
import tailwindcssAnimate from 'tailwindcss-animate';
import { fontFamily } from 'tailwindcss/defaultTheme';

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
        // Custom Brand Colors
        'custom-orange': {
          50: 'hsl(var(--custom-orange-50))',
          100: 'hsl(var(--custom-orange-100))',
          200: 'hsl(var(--custom-orange-200))',
          300: 'hsl(var(--custom-orange-300))',
          400: 'hsl(var(--custom-orange-400))',
          500: 'hsl(var(--custom-orange-500))',
          600: 'hsl(var(--custom-orange-600))',
          700: 'hsl(var(--custom-orange-700))',
          800: 'hsl(var(--custom-orange-800))',
          900: 'hsl(var(--custom-orange-900))',
          950: 'hsl(var(--custom-orange-950))'
        },
        'custom-blue': {
          50: 'hsl(var(--custom-blue-50))',
          100: 'hsl(var(--custom-blue-100))',
          200: 'hsl(var(--custom-blue-200))',
          300: 'hsl(var(--custom-blue-300))',
          400: 'hsl(var(--custom-blue-400))',
          500: 'hsl(var(--custom-blue-500))',
          600: 'hsl(var(--custom-blue-600))',
          700: 'hsl(var(--custom-blue-700))',
          800: 'hsl(var(--custom-blue-800))',
          900: 'hsl(var(--custom-blue-900))',
          950: 'hsl(var(--custom-blue-950))'
        },
        'custom-red': {
          50: 'hsl(var(--custom-red-50))',
          100: 'hsl(var(--custom-red-100))',
          200: 'hsl(var(--custom-red-200))',
          300: 'hsl(var(--custom-red-300))',
          400: 'hsl(var(--custom-red-400))',
          500: 'hsl(var(--custom-red-500))',
          600: 'hsl(var(--custom-red-600))',
          700: 'hsl(var(--custom-red-700))',
          800: 'hsl(var(--custom-red-800))',
          900: 'hsl(var(--custom-red-900))',
          950: 'hsl(var(--custom-red-950))'
        },
        'custom-green': {
          50: 'hsl(var(--custom-green-50))',
          100: 'hsl(var(--custom-green-100))',
          200: 'hsl(var(--custom-green-200))',
          300: 'hsl(var(--custom-green-300))',
          400: 'hsl(var(--custom-green-400))',
          500: 'hsl(var(--custom-green-500))',
          600: 'hsl(var(--custom-green-600))',
          700: 'hsl(var(--custom-green-700))',
          800: 'hsl(var(--custom-green-800))',
          900: 'hsl(var(--custom-green-900))',
          950: 'hsl(var(--custom-green-950))'
        },
        'custom-blue-light': 'hsl(var(--custom-blue-light))',
        'custom-pink': 'hsl(var(--custom-pink))',
        'custom-green-light': 'hsl(var(--custom-green-light))',
        // Override default Tailwind colors with terra colors
        blue: {
          50: 'hsl(var(--terra-blue-50))',
          100: 'hsl(var(--terra-blue-100))',
          200: 'hsl(var(--terra-blue-200))',
          300: 'hsl(var(--terra-blue-300))',
          400: 'hsl(var(--terra-blue-400))',
          500: 'hsl(var(--terra-blue-500))',
          600: 'hsl(var(--terra-blue-600))',
          700: 'hsl(var(--terra-blue-700))',
          800: 'hsl(var(--terra-blue-800))',
          900: 'hsl(var(--terra-blue-900))',
          950: 'hsl(var(--terra-blue-950))'
        },
        red: {
          50: 'hsl(var(--terra-red-50))',
          100: 'hsl(var(--terra-red-100))',
          200: 'hsl(var(--terra-red-200))',
          300: 'hsl(var(--terra-red-300))',
          400: 'hsl(var(--terra-red-400))',
          500: 'hsl(var(--terra-red-500))',
          600: 'hsl(var(--terra-red-600))',
          700: 'hsl(var(--terra-red-700))',
          800: 'hsl(var(--terra-red-800))',
          900: 'hsl(var(--terra-red-900))',
          950: 'hsl(var(--terra-red-950))'
        },
        yellow: {
          50: 'hsl(var(--terra-yellow-50))',
          100: 'hsl(var(--terra-yellow-100))',
          200: 'hsl(var(--terra-yellow-200))',
          300: 'hsl(var(--terra-yellow-300))',
          400: 'hsl(var(--terra-yellow-400))',
          500: 'hsl(var(--terra-yellow-500))',
          600: 'hsl(var(--terra-yellow-600))',
          700: 'hsl(var(--terra-yellow-700))',
          800: 'hsl(var(--terra-yellow-800))',
          900: 'hsl(var(--terra-yellow-900))',
          950: 'hsl(var(--terra-yellow-950))'
        },
        green: {
          50: 'hsl(var(--terra-green-50))',
          100: 'hsl(var(--terra-green-100))',
          200: 'hsl(var(--terra-green-200))',
          300: 'hsl(var(--terra-green-300))',
          400: 'hsl(var(--terra-green-400))',
          500: 'hsl(var(--terra-green-500))',
          600: 'hsl(var(--terra-green-600))',
          700: 'hsl(var(--terra-green-700))',
          800: 'hsl(var(--terra-green-800))',
          900: 'hsl(var(--terra-green-900))',
          950: 'hsl(var(--terra-green-950))'
        },
        purple: {
          50: 'hsl(var(--terra-purple-50))',
          100: 'hsl(var(--terra-purple-100))',
          200: 'hsl(var(--terra-purple-200))',
          300: 'hsl(var(--terra-purple-300))',
          400: 'hsl(var(--terra-purple-400))',
          500: 'hsl(var(--terra-purple-500))',
          600: 'hsl(var(--terra-purple-600))',
          700: 'hsl(var(--terra-purple-700))',
          800: 'hsl(var(--terra-purple-800))',
          900: 'hsl(var(--terra-purple-900))',
          950: 'hsl(var(--terra-purple-950))'
        },
        gray: {
          50: 'hsl(var(--terra-gray-50))',
          100: 'hsl(var(--terra-gray-100))',
          200: 'hsl(var(--terra-gray-200))',
          300: 'hsl(var(--terra-gray-300))',
          400: 'hsl(var(--terra-gray-400))',
          500: 'hsl(var(--terra-gray-500))',
          600: 'hsl(var(--terra-gray-600))',
          700: 'hsl(var(--terra-gray-700))',
          800: 'hsl(var(--terra-gray-800))',
          900: 'hsl(var(--terra-gray-900))',
          950: 'hsl(var(--terra-gray-950))'
        },
        orange: {
          50: 'hsl(var(--terra-orange-50))',
          100: 'hsl(var(--terra-orange-100))',
          200: 'hsl(var(--terra-orange-200))',
          300: 'hsl(var(--terra-orange-300))',
          400: 'hsl(var(--terra-orange-400))',
          500: 'hsl(var(--terra-orange-500))',
          600: 'hsl(var(--terra-orange-600))',
          700: 'hsl(var(--terra-orange-700))',
          800: 'hsl(var(--terra-orange-800))',
          900: 'hsl(var(--terra-orange-900))',
          950: 'hsl(var(--terra-orange-950))'
        },
        teal: {
          50: 'hsl(var(--terra-teal-50))',
          100: 'hsl(var(--terra-teal-100))',
          200: 'hsl(var(--terra-teal-200))',
          300: 'hsl(var(--terra-teal-300))',
          400: 'hsl(var(--terra-teal-400))',
          500: 'hsl(var(--terra-teal-500))',
          600: 'hsl(var(--terra-teal-600))',
          700: 'hsl(var(--terra-teal-700))',
          800: 'hsl(var(--terra-teal-800))',
          900: 'hsl(var(--terra-teal-900))',
          950: 'hsl(var(--terra-teal-950))'
        },
        pink: {
          50: 'hsl(var(--terra-pink-50))',
          100: 'hsl(var(--terra-pink-100))',
          200: 'hsl(var(--terra-pink-200))',
          300: 'hsl(var(--terra-pink-300))',
          400: 'hsl(var(--terra-pink-400))',
          500: 'hsl(var(--terra-pink-500))',
          600: 'hsl(var(--terra-pink-600))',
          700: 'hsl(var(--terra-pink-700))',
          800: 'hsl(var(--terra-pink-800))',
          900: 'hsl(var(--terra-pink-900))',
          950: 'hsl(var(--terra-pink-950))'
        },
        indigo: {
          50: 'hsl(var(--terra-indigo-50))',
          100: 'hsl(var(--terra-indigo-100))',
          200: 'hsl(var(--terra-indigo-200))',
          300: 'hsl(var(--terra-indigo-300))',
          400: 'hsl(var(--terra-indigo-400))',
          500: 'hsl(var(--terra-indigo-500))',
          600: 'hsl(var(--terra-indigo-600))',
          700: 'hsl(var(--terra-indigo-700))',
          800: 'hsl(var(--terra-indigo-800))',
          900: 'hsl(var(--terra-indigo-900))',
          950: 'hsl(var(--terra-indigo-950))'
        },
        emerald: {
          50: 'hsl(var(--terra-emerald-50))',
          100: 'hsl(var(--terra-emerald-100))',
          200: 'hsl(var(--terra-emerald-200))',
          300: 'hsl(var(--terra-emerald-300))',
          400: 'hsl(var(--terra-emerald-400))',
          500: 'hsl(var(--terra-emerald-500))',
          600: 'hsl(var(--terra-emerald-600))',
          700: 'hsl(var(--terra-emerald-700))',
          800: 'hsl(var(--terra-emerald-800))',
          900: 'hsl(var(--terra-emerald-900))',
          950: 'hsl(var(--terra-emerald-950))'
        },
        violet: {
          50: 'hsl(var(--terra-violet-50))',
          100: 'hsl(var(--terra-violet-100))',
          200: 'hsl(var(--terra-violet-200))',
          300: 'hsl(var(--terra-violet-300))',
          400: 'hsl(var(--terra-violet-400))',
          500: 'hsl(var(--terra-violet-500))',
          600: 'hsl(var(--terra-violet-600))',
          700: 'hsl(var(--terra-violet-700))',
          800: 'hsl(var(--terra-violet-800))',
          900: 'hsl(var(--terra-violet-900))',
          950: 'hsl(var(--terra-violet-950))'
        },
        slate: {
          50: 'hsl(var(--terra-slate-50))',
          100: 'hsl(var(--terra-slate-100))',
          200: 'hsl(var(--terra-slate-200))',
          300: 'hsl(var(--terra-slate-300))',
          400: 'hsl(var(--terra-slate-400))',
          500: 'hsl(var(--terra-slate-500))',
          600: 'hsl(var(--terra-slate-600))',
          700: 'hsl(var(--terra-slate-700))',
          800: 'hsl(var(--terra-slate-800))',
          900: 'hsl(var(--terra-slate-900))',
          950: 'hsl(var(--terra-slate-950))'
        },
        zinc: {
          50: 'hsl(var(--terra-zinc-50))',
          100: 'hsl(var(--terra-zinc-100))',
          200: 'hsl(var(--terra-zinc-200))',
          300: 'hsl(var(--terra-zinc-300))',
          400: 'hsl(var(--terra-zinc-400))',
          500: 'hsl(var(--terra-zinc-500))',
          600: 'hsl(var(--terra-zinc-600))',
          700: 'hsl(var(--terra-zinc-700))',
          800: 'hsl(var(--terra-zinc-800))',
          900: 'hsl(var(--terra-zinc-900))',
          950: 'hsl(var(--terra-zinc-950))'
        },
        neutral: {
          50: 'hsl(var(--terra-neutral-50))',
          100: 'hsl(var(--terra-neutral-100))',
          200: 'hsl(var(--terra-neutral-200))',
          300: 'hsl(var(--terra-neutral-300))',
          400: 'hsl(var(--terra-neutral-400))',
          500: 'hsl(var(--terra-neutral-500))',
          600: 'hsl(var(--terra-neutral-600))',
          700: 'hsl(var(--terra-neutral-700))',
          800: 'hsl(var(--terra-neutral-800))',
          900: 'hsl(var(--terra-neutral-900))',
          950: 'hsl(var(--terra-neutral-950))'
        },
        stone: {
          50: 'hsl(var(--terra-stone-50))',
          100: 'hsl(var(--terra-stone-100))',
          200: 'hsl(var(--terra-stone-200))',
          300: 'hsl(var(--terra-stone-300))',
          400: 'hsl(var(--terra-stone-400))',
          500: 'hsl(var(--terra-stone-500))',
          600: 'hsl(var(--terra-stone-600))',
          700: 'hsl(var(--terra-stone-700))',
          800: 'hsl(var(--terra-stone-800))',
          900: 'hsl(var(--terra-stone-900))',
          950: 'hsl(var(--terra-stone-950))'
        },
        // Semantic colors
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
          DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
          foreground: 'hsl(var(--muted-foreground) / <alpha-value>)'
        },
        accent: {
          DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
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
        // Button specific colors
        'button-hover': 'hsl(var(--button-hover) / <alpha-value>)',
        'button-hover-foreground': 'hsl(var(--button-hover-foreground) / <alpha-value>)',
        // Surface brand colors
        surface: {
          'brand-solid': 'hsl(var(--surface-brand-solid))',
          'brand-solid-hover': 'hsl(var(--surface-brand-solid-hover))',
          primary: 'hsl(var(--surface-primary))',
          secondary: 'hsl(var(--surface-secondary))',
          tertiary: 'hsl(var(--surface-tertiary))'
        }
      },
      borderRadius: {
        xl: 'calc(var(--radius) * 2)',
        lg: 'var(--radius)',
        md: 'calc(var(--radius) * 0.75)',
        sm: 'calc(var(--radius) * 0.5)'
      },
      fontFamily: {
        sans: ['geist-sans', ...fontFamily.sans]
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
