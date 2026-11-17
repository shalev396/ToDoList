import { cva } from 'class-variance-authority';

/**
 * Calls to action on the public pages. The primary one is a pill in the brand's deep ochre
 * (--primary; docs/design/DESIGN.md: 999px radius for chips and the primary CTA), the only place
 * besides focus and the selected wash where the brand hue shows.
 */
export const ctaVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap transition-colors duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      tone: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary/85',
        secondary: 'border bg-card text-foreground hover:bg-sunken',
        quiet: 'text-foreground hover:bg-sunken',
      },
      size: {
        sm: 'h-9 px-4 text-sm',
        md: 'h-11 px-5 text-[15px]',
      },
    },
    defaultVariants: { tone: 'primary', size: 'md' },
  },
);
