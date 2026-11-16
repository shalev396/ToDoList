import { Toaster } from 'sonner';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/components/theme-context';
import { isRTL } from '@/i18n/config';

export function DirectionalToaster() {
  const { i18n } = useTranslation();
  // Sonner draws light toasts unless told otherwise: in the dark theme they were light boxes.
  const { theme } = useTheme();
  const position = isRTL(i18n.language) ? 'bottom-left' : 'bottom-right';

  return (
    <Toaster
      theme={theme}
      position={position}
      richColors
      closeButton
      // Sonner's defaults (24px / 16px) plus the home indicator inset in the Home Screen web app.
      // On a phone the sides are 20px, not 16px: the close button sits on the toast's corner, and
      // its 44px touch target (index.css) is centred on it, so it needs 20px to stay on screen.
      offset={{ bottom: 'calc(24px + env(safe-area-inset-bottom))' }}
      mobileOffset={{
        bottom: 'calc(16px + env(safe-area-inset-bottom))',
        left: '20px',
        right: '20px',
      }}
    />
  );
}
