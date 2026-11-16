/** Topics: the workspace's pages (H2). Their names are the workspace's own, free text. */
export const topics = {
  /** An item without a topic (none set, or its topic was deleted). */
  unsorted: 'ללא נושא',
  all: 'כל הנושאים',
  addPage: 'הוספת עמוד',
  add: {
    title: 'הוספת עמוד',
    body: 'עמוד משלו לעבודה, לקורס, לפרויקט או לכל דבר אחר. כל מי שב-⁠{{workspace}} יראה אותו.',
    name: 'שם',
    namePlaceholder: 'למשל: עבודת לילה',
    nameRequired: 'צריך לתת לעמוד שם.',
    template: 'להתחיל מ',
    submit: 'הוספת עמוד',
    submitting: 'מוסיפים…',
    done: '„{{name}}” נוסף',
    failed: 'לא הצלחנו להוסיף את העמוד. נסו שוב.',
  },
  templates: {
    none: 'עמוד ריק',
    work: 'פריסת עבודה',
    college: 'פריסת לימודים',
    personal: 'פריסה אישית',
    dashboard: 'פריסת סקירה',
  },
  cancel: 'ביטול',
  menu: 'אפשרויות עבור {{name}}',
  rename: 'שינוי שם',
  renameLabel: 'שם חדש ל-⁠{{name}}',
  renamed: 'השם שונה ל-„{{name}}”',
  renameFailed: 'לא הצלחנו לשנות את השם. נסו שוב.',
  delete: 'מחיקה',
  deleteTitle: 'למחוק את „{{name}}”?',
  deleteBody:
    'הלוחות, התצוגות, הפריסה והמסננים שלו יימחקו. הפריטים שלו נשארים במרחב העבודה בלי נושא, וגם המשימות המקומיות נשארות.',
  deleteConfirm: 'מחיקת העמוד',
  deleted: '„{{name}}” נמחק',
  deleteFailed: 'לא הצלחנו למחוק את העמוד. נסו שוב.',
};
