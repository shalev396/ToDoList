/**
 * The pricing page. Every number on it comes from the shared limits (data/limits.ts, read from
 * server/src/types/limits.ts) through {{count}}, so none is written here.
 */
export const pricing = {
  meta: {
    title: 'מחירים',
    description:
      'TodoList חינם ליחידים, בלי הגבלה על תכונות: כל החיבורים, גישת MCP לסוכני AI, משימות בלי הגבלה, תבניות ושיתוף. בלי תוכניות בתשלום, בלי תקופת ניסיון ובלי כרטיס אשראי.',
  },
  title: 'תוכנית אחת, והיא בחינם',
  lead: 'TodoList חינם לסטודנטים, לחברים ללימודים ולכל מי שרוצה. בלי תוכניות בתשלום, בלי תקופת ניסיון ובלי כרטיס אשראי.',
  plan: {
    name: 'יחיד',
    price: 'חינם',
    period: 'בלי הגבלה על תכונות',
    description: 'כל מה ש-⁠TodoList עושה, בשבילכם ובשביל מי שאתם משתפים איתו.',
    cta: 'יצירת מרחב עבודה',
    includedTitle: 'מה כלול',
    included: {
      integrations: {
        title_one: 'חיבור אחד',
        title_two: 'שני החיבורים',
        title_other: 'כל {{count}} החיבורים',
        detail_one: '{{list}}, עד חיבור אחד משלכם בכל מרחב עבודה',
        detail_two: '{{list}}, עד שני חיבורים משלכם בכל מרחב עבודה',
        detail_other: '{{list}}, עד {{count}} חיבורים משלכם בכל מרחב עבודה',
      },
      agents: {
        title: 'גישת MCP לסוכני AI',
        detail_one: 'מפתח אחד לסוכן, ואפשר לבטל אותו בכל רגע',
        detail_two: 'עד שני מפתחות לסוכנים, וכל אחד אפשר לבטל בכל רגע',
        detail_other: 'עד {{count}} מפתחות לסוכנים, וכל אחד אפשר לבטל בכל רגע',
      },
      todos: {
        unlimited: 'משימות בלי הגבלה',
        limited_one: 'משימה אחת בכל מרחב עבודה',
        limited_two: 'עד שתי משימות בכל מרחב עבודה',
        limited_other: 'עד {{count}} משימות בכל מרחב עבודה',
        detail: 'שלכם, לצד כל מה שמגיע מהכלים שלכם',
      },
      workspaces: {
        title_one: 'מרחב עבודה אחד',
        title_two: 'עד שני מרחבי עבודה',
        title_other: 'עד {{count}} מרחבי עבודה',
        detail_one: 'כל אחד משותף עם חבר אחד לכל היותר',
        detail_two: 'כל אחד משותף עם עד שני חברים',
        detail_other: 'כל אחד משותף עם עד {{count}} חברים',
      },
      blocks: {
        title_one: 'בלוק אחד בכל עמוד',
        title_two: 'שני בלוקים בכל עמוד',
        title_other: '{{count}} בלוקים בכל עמוד',
        detail: 'שעון, יומן, תאריכי יעד, לוחות, רשימות, גרפים ועוד',
      },
      attributes: {
        title_one: 'מאפיין מותאם אחד בכל מרחב עבודה',
        title_two: 'שני מאפיינים מותאמים בכל מרחב עבודה',
        title_other: '{{count}} מאפיינים מותאמים בכל מרחב עבודה',
        detail: 'חשיבות, מאמץ או כל דבר שאתם עוקבים אחריו, נשמר ב־TodoList ולא נכתב לכלים שלכם',
      },
      views: {
        title_one: 'תצוגה אחת בכל עמוד',
        title_two: 'שתי תצוגות בכל עמוד',
        title_other: '{{count}} תצוגות בכל עמוד',
        detail: 'אותו עמוד כסיכום, כרשימה, כלוח ועוד',
      },
      templates: {
        title: 'תבניות של תצוגות ובלוקים',
        detail: 'מתחילים כל עמוד מסידור מוכן',
      },
    },
    /** מחבר את שמות החיבורים: "א, ב ו-ג". RLM after each comma keeps Latin names in RTL order. */
    list: {
      separator: ',‏ ',
      last: ' ו-⁠',
    },
  },
  business: {
    title: 'עסק או בית ספר?',
    body: 'ספרו לנו מה הצוות או הכיתה שלכם צריכים ונחזור אליכם.',
    cta: 'יצירת קשר',
  },
};
