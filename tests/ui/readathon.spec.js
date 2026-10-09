// End-to-end flows against the dev server (fresh in-memory data, today = 2026-10-09).
const { test, expect } = require('@playwright/test');

// Tiny 2x3 PNG so cover images "load" without hitting Open Library
// (the app ignores 1x1 images, which Open Library returns for missing covers).
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEElEQVR4nGMQ1vQGIgYUCgAf/gMrQrmzIAAAAABJRU5ErkJggg==', 'base64');

async function stubOpenLibrary(page) {
  await page.route('https://openlibrary.org/search.json**', (route) => route.fulfill({
    json: { docs: [{ title: 'Charlotte\'s Web', author_name: ['E. B. White'], cover_i: 8228691, isbn: ['9780064400558'] }] },
  }));
  await page.route('https://covers.openlibrary.org/**', (route) => route.fulfill({ body: PIXEL, contentType: 'image/png' }));
}

async function students(request) {
  const res = await request.post('/api', { data: { action: 'admin.overview', idToken: 'dev:organizer@example.com' } });
  return (await res.json()).data.students;
}

test.beforeEach(async ({ page }) => {
  await stubOpenLibrary(page);
});

test('student logs minutes, picks a book, and hides things from the donation page', async ({ page, request }) => {
  // The dev seed gives every other student demo minutes; use one without any.
  const s = (await students(request))[1];
  await page.goto('/s/' + s.token);
  await expect(page.getByRole('heading', { name: `Hi, ${s.firstName}!` })).toBeVisible();

  await page.getByLabel('Minutes read today').fill('25');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#today-status')).toHaveText('Saved ✓');
  await page.getByRole('button', { name: '+10' }).click();
  await expect(page.locator('#today-status')).toHaveText('Saved ✓');
  await expect(page.getByLabel('Minutes read on Thu, Oct 8')).toBeVisible();
  await page.getByLabel('Minutes read on Thu, Oct 8').fill('15');
  await page.getByLabel('Minutes read on Thu, Oct 8').press('Tab');
  await expect(page.locator('[data-bind=totalMinutes]')).toHaveText('50');
  await expect(page.getByLabel('Minutes read on Fri, Oct 9')).toHaveValue('35');

  await page.getByRole('button', { name: 'Add my book' }).click();
  await page.locator('#current-title').fill('charlotte');
  await page.getByRole('button', { name: /Charlotte's Web/ }).click();
  await expect(page.locator('#current-author')).toHaveValue('E. B. White');
  await page.getByRole('button', { name: 'Save book' }).click();
  await expect(page.locator('#current-book .title')).toHaveText("Charlotte's Web");
  await expect(page.locator('#current-book img.cover')).toBeVisible();

  await page.getByRole('button', { name: /I finished it/ }).click();
  await expect(page.locator('#finished-books .title')).toHaveText("Charlotte's Web");

  await page.getByLabel('My reading goal (minutes)').fill('300');
  await page.getByLabel('My reading goal (minutes)').press('Tab');
  await expect(page.locator('#prefs-status')).toHaveText('Saved ✓');

  // Donation page shows everything by default.
  const donate = await page.context().newPage();
  await stubOpenLibrary(donate);
  await donate.goto('/d/' + s.code);
  await expect(donate.getByRole('heading', { name: `Support ${s.firstName} ${s.lastName[0]}.'s reading!` })).toBeVisible();
  await expect(donate.locator('.stat').first()).toContainText('50');
  await expect(donate.locator('#shelf .title')).toHaveText("Charlotte's Web");
  await expect(donate.locator('#shelf img.cover')).toBeVisible();
  await expect(donate.locator('#goal-card')).toContainText('300 minutes');
  await expect(donate.locator('#widget a')).toContainText(`Donate in honor of ${s.firstName}`);

  // Hide the reading list and minutes, then check the donation page again.
  await page.getByLabel('Show my reading list').uncheck();
  await expect(page.locator('#prefs-status')).toHaveText('Saved ✓');
  await page.getByLabel("Show how many minutes I've read").uncheck();
  await expect(page.locator('#prefs-status')).toHaveText('Saved ✓');
  await donate.reload();
  await expect(donate.locator('#widget a')).toBeVisible();
  await expect(donate.locator('#reading')).toBeHidden();
  await expect(donate.locator('#goal-card')).toBeHidden();
  await expect(donate.locator('.stat')).toHaveCount(1); // class minutes only
});

test('bad links show a friendly error', async ({ page }) => {
  await page.goto('/s/notARealTokenAtAll1234');
  await expect(page.getByRole('alert')).toContainText('could not find');
  await page.goto('/d/NOPE99');
  await expect(page.getByRole('alert')).toContainText('could not find');
});

test('organizer configures the donation widget with template values', async ({ page, request }) => {
  const s = (await students(request))[2];
  await page.goto('/admin');
  // The dev server stands in for Google: only DEV_ADMINS count as spreadsheet editors.
  await page.getByLabel('Email').fill('parent@example.com');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#login-status')).toContainText("doesn't have edit access");
  await page.getByLabel('Email').fill('organizer@example.com');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#overview-stats')).toContainText('total minutes');
  await expect(page.locator('#who')).toHaveText('organizer@example.com');

  // The session survives a reload (sessionStorage) and ends on sign out.
  await page.reload();
  await expect(page.locator('#overview-stats')).toContainText('total minutes');

  await page.getByRole('tab', { name: 'Students & links' }).click();
  await page.getByPlaceholder(/Search by name/).fill(s.code);
  await expect(page.locator('#student-rows tr')).toHaveCount(1);

  await page.getByRole('tab', { name: 'Donation widget' }).click();
  await page.getByLabel('Donation widget HTML').fill(
    '<p id="w">For {studentName} in grade {studentGrade} ({studentTeacher})</p>' +
    '<script>document.getElementById("w").dataset.ran = {studentFirstName:json};</script>');
  await page.getByRole('button', { name: 'Save widget' }).click();
  await expect(page.locator('#widget-status')).toHaveText('Saved ✓');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Organizer sign in' })).toBeVisible();

  await page.goto('/d/' + s.code);
  const w = page.locator('#widget #w');
  await expect(w).toHaveText(`For ${s.firstName} ${s.lastName[0]}. in grade ${s.grade} (${s.teacher})`);
  await expect(w).toHaveAttribute('data-ran', s.firstName); // widget scripts execute
});

test('home page shows school totals', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Bishop Readathon' })).toBeVisible();
  await expect(page.getByText('minutes read school-wide')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Class leaderboard' })).toBeVisible();
});
