/** The signed-in app's frame: sidebar, workspace switcher, user menu, mobile bars, shared states. */
export const app = {
  name: '{{appName}}',
  shell: {
    nav: 'ראשי',
    skipToContent: 'דילוג לתוכן',
    search: 'חיפוש',
    dashboard: 'לוח בקרה',
    integrations: 'חיבורים',
    templates: 'תבניות',
    settings: 'הגדרות',
    workspace: 'מרחב עבודה',
    collapse: 'כיווץ סרגל הצד',
    expand: 'הרחבת סרגל הצד',
    sections: 'אזורים',
    more: 'עוד',
    noWorkspace: 'עדיין אין מרחב עבודה',
    createWorkspace: 'יצירת מרחב עבודה',
  },
  workspaceSwitcher: {
    trigger: '{{workspace}}, החלפת מרחב עבודה',
    triggerEmpty: 'מרחבי עבודה',
    yours: 'מרחבי העבודה שלך',
    create: 'יצירת מרחב עבודה',
    join: 'הצטרפות עם קישור הזמנה',
  },
  join: {
    title: 'הצטרפות עם קישור הזמנה',
    description: 'הדביקו את הקישור מאימייל ההזמנה.',
    label: 'קישור הזמנה',
    submit: 'פתיחת ההזמנה',
    invalid: 'זה לא קישור הזמנה. העתיקו את כל הקישור מהאימייל.',
  },
  userMenu: {
    trigger: 'חשבון: {{name}}',
    profile: 'פרופיל',
    theme: 'ערכת צבעים',
    language: 'שפה',
    signOut: 'התנתקות',
  },
  roles: {
    owner: 'בעלים',
    editor: 'עריכה',
    viewer: 'צפייה',
  },
  page: {
    loading: 'טוען…',
    loadError: 'לא הצלחנו לטעון את מרחבי העבודה שלך.',
    retry: 'ניסיון נוסף',
    close: 'סגירה',
  },
  topic: {
    missingTitle: 'העמוד הזה לא זמין',
    missingBody: 'אין ב-\u2060{{workspace}} עמוד בכתובת הזו. ייתכן שהוא נמחק.',
    backToDashboard: 'מעבר ללוח הבקרה',
  },
  integrations: {
    title: 'חיבורים',
    emptyTitle: 'החיבורים יגיעו לכאן',
    emptyBody:
      'מכאן תחברו את Jira,\u200F ClickUp,\u200F Linear, יומן Google ו-\u2060GitHub. רק בעלים יכולים לחבר מקורות.',
  },
  templates: {
    title: 'תבניות',
    emptyTitle: 'התבניות יגיעו לכאן',
    emptyBody: 'פותחים עמוד מתבנית של עבודה, לימודים או אישי, או מעמוד ריק.',
  },
  itemLink: {
    title: 'אי אפשר לפתוח את הפריט הזה',
    body: 'הוא שייך למרחב עבודה שלא הצטרפת אליו.',
    action: 'מעבר ללוח הבקרה',
  },
};
