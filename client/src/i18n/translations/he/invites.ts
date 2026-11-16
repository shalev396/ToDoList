/** The invite accept page (/:lng/invites/:token). */
export const invites = {
  title: 'הצטרפות למרחב עבודה',
  lead: 'הוזמנתם למרחב עבודה ב-\u2060{{appName}}.',
  signedInAs: 'נכנסתם כ-\u2060{{email}}. ההזמנה צריכה להיות לכתובת הזאת.',
  accept: 'קבלת ההזמנה',
  accepting: 'מצטרפים…',
  joined: 'הצטרפתם אל {{workspace}}',
  useAnotherAccount: 'כניסה עם חשבון אחר',
  goToDashboard: 'מעבר ללוח הבקרה',
  tryAgain: 'ניסיון נוסף',
  errors: {
    wrongEmailTitle: 'ההזמנה הזאת מיועדת לכתובת אימייל אחרת',
    wrongEmailBody: 'נכנסתם כ-\u2060{{email}}. התנתקו והיכנסו עם הכתובת שאליה נשלחה ההזמנה.',
    expiredTitle: 'קישור ההזמנה כבר לא עובד',
    expiredBody: 'תוקפו פג, או שהבעלים ביטלו אותו או שלחו הזמנה חדשה יותר. בקשו מהם הזמנה חדשה.',
    usedTitle: 'כבר השתמשו בהזמנה הזאת',
    usedBody: 'אם קיבלתם אותה קודם, מרחב העבודה כבר מופיע ברשימה שלכם.',
    alreadyMemberTitle: 'כבר יש לך גישה למרחב העבודה הזה',
    alreadyMemberBody: 'הוא כבר מופיע ברשימת מרחבי העבודה שלך.',
    workspaceFullTitle: 'מרחב העבודה הזה מלא',
    workspaceFullBody:
      'יש בו כבר {{membersPerWorkspace}} חברים. בקשו מהבעלים לפנות מקום ופתחו את הקישור שוב.',
    unknownTitle: 'לא הצלחנו לקבל את ההזמנה',
    unknownBody: 'בדקו את החיבור לאינטרנט ונסו שוב.',
  },
  join: {
    title: 'הצטרפות למרחב עבודה',
    lead: 'פתחתם קישור הצטרפות למרחב עבודה ב-\u2060{{appName}}.',
    signedInAs: 'אתם מחוברים בתור {{email}}. כל חשבון יכול להשתמש בקישור הזה.',
    accept: 'הצטרפות למרחב העבודה',
    errors: {
      goneTitle: 'קישור ההצטרפות הזה כבר לא עובד',
      goneBody: 'הבעלים איפסו אותו או כיבו אותו. בקשו מהם את הקישור הנוכחי.',
      alreadyMemberTitle: 'כבר יש לך גישה למרחב העבודה הזה',
      alreadyMemberBody: 'הוא כבר מופיע ברשימת מרחבי העבודה שלך.',
      workspaceFullTitle: 'מרחב העבודה הזה מלא',
      workspaceFullBody:
        'כבר יש בו {{membersPerWorkspace}} חברים. בקשו מהבעלים לפנות מקום, ואז פתחו את הקישור שוב.',
      unknownTitle: 'לא הצלחנו להצטרף',
      unknownBody: 'בדקו את החיבור לאינטרנט ונסו שוב.',
    },
  },
};
