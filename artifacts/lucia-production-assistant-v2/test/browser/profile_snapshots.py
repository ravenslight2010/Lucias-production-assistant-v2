"""Real authenticated browser regression; see README.md for safe setup."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import subprocess
import uuid

from playwright.async_api import async_playwright, expect


APP = Path(__file__).resolve().parents[2]


def workbook(marker):
    # Use the application's actual XLSX writer, not a renamed CSV fixture.
    result = subprocess.run(
        ["node", "--input-type=module", "-e", """
import * as XLSX from 'xlsx';
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
  ['Pizza recipe specs', process.argv[1]], ['Sauce oz / pizza', 2],
]), 'Product specs');
process.stdout.write(XLSX.write(book, {type: 'buffer', bookType: 'xlsx'}));
""", marker], cwd=APP, check=True, capture_output=True,
    )
    return {"name": f"{marker}.xlsx",
            "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "buffer": result.stdout}


async def run_journey(page, base_url):
    """Accept an already Clerk-authenticated page; never bypass API auth."""
    base = base_url.rstrip("/")
    token = uuid.uuid4().hex[:10]
    brand, flavor = f"Snapshot {token}", "Original flavor"
    renamed, winner = f"Renamed {token}", f"Other operator {token}"
    target_brand = f"Destination {token}"
    original, addition, destination = (f"{kind}-{token}" for kind in ("original", "addition", "destination"))

    def response(method, suffix):
        return lambda r: r.request.method == method and r.url.split("?")[0].endswith(suffix)

    async def import_profile(brand_name, flavor_name, marker):
        await page.get_by_test_id("input-workbook-file").set_input_files(workbook(marker))
        await page.get_by_test_id("select-workbook-kind").select_option("product_specs")
        await page.locator("#profile-brand").fill(brand_name)
        await page.locator("#profile-flavor").fill(flavor_name)
        async with page.expect_response(response("POST", "/v2/product-profiles")) as pending:
            await page.get_by_test_id("button-import-profile").click()
        saved = await pending.value
        assert saved.ok, await saved.text()
        return (await saved.json())["profile"]

    async def check_snapshot():
        # A direct URL and reload defeat any client-side run cache.
        async with page.expect_response(response("GET", f"/v2/runs/{run_id}")) as pending:
            await page.goto(f"{base}/runs/{run_id}")
        loaded = await pending.value
        assert loaded.ok, await loaded.text()
        assert (await loaded.json())["run"]["productSnapshot"] == captured
        await page.reload()
        panel = page.locator(".snapshot-panel")
        await expect(panel.get_by_text(f"{brand} / {flavor}", exact=True)).to_be_visible()
        await expect(panel.get_by_text(f"#{captured['revision']}", exact=True)).to_be_visible()
        await panel.get_by_text("View captured source data", exact=True).click()
        assert json.loads(await panel.locator("pre").inner_text()) == captured["productData"]

    await page.goto(f"{base}/imports")
    await expect(page.get_by_role("heading", name="Product profiles", exact=True)).to_be_visible()
    profile = await import_profile(brand, flavor, original)
    profile_id = profile["id"]
    await expect(page.get_by_test_id(f"card-profile-{profile_id}")).to_contain_text("REV 00")
    await page.get_by_test_id("link-nav-production-runs").click()
    await page.get_by_test_id("button-toggle-create-run").click()
    await page.get_by_test_id("select-run-brand").select_option(brand)
    await page.get_by_test_id("select-run-flavor").select_option(profile_id)
    await page.get_by_test_id("input-run-target-cases").fill("17")
    async with page.expect_response(response("POST", "/v2/runs")) as pending:
        await page.get_by_role("button", name="Create planned run", exact=True).click()
    created = await pending.value
    assert created.ok, await created.text()
    run = (await created.json())["run"]
    run_id, captured = run["id"], run["productSnapshot"]
    assert captured["brand"] == brand and captured["flavor"] == flavor
    assert captured["revision"] == profile["revision"]
    assert captured["productData"] == profile["productData"]
    await check_snapshot()

    await page.goto(f"{base}/imports")
    revised = await import_profile(brand, flavor, addition)
    assert revised["id"] == profile_id and revised["revision"] == profile["revision"] + 1
    card = page.get_by_test_id(f"card-profile-{profile_id}")
    await expect(card).to_contain_text("2 source workbooks")
    await card.get_by_role("button", name="Rename profile", exact=True).click()
    await card.get_by_label("Brand", exact=True).fill(renamed)
    await card.get_by_label("Flavor", exact=True).fill("Renamed flavor")
    await card.get_by_role("button", name="Save rename", exact=True).click()
    await expect(card.get_by_role("heading")).to_have_text(f"{renamed} / Renamed flavor")
    await check_snapshot()

    await page.goto(f"{base}/imports")
    target = await import_profile(target_brand, "Target flavor", destination)
    card = page.get_by_test_id(f"card-profile-{profile_id}")
    await card.locator("select").select_option(target["id"])
    await card.get_by_role("button", name="Merge profiles", exact=True).click()
    await expect(card.get_by_role("group", name="Confirm profile merge")).to_be_visible()
    await card.get_by_role("button", name="Keep profiles separate").click()
    await expect(card).to_be_visible()
    await card.get_by_role("button", name="Merge profiles", exact=True).click()
    async with page.expect_response(response("POST", f"/v2/product-profiles/{profile_id}/merge")) as pending:
        await card.get_by_role("button", name="Confirm and merge", exact=True).click()
    merged_response = await pending.value
    assert merged_response.ok, await merged_response.text()
    merged = (await merged_response.json())["profile"]
    await expect(card).to_have_count(0)  # invalidation, not a forced navigation
    target_card = page.get_by_test_id(f"card-profile-{target['id']}")
    await expect(target_card).to_contain_text(f"REV {merged['revision']:02d}")
    preserved = json.dumps(merged["productData"])
    assert all(marker in preserved for marker in (original, addition, destination))
    await page.get_by_test_id("link-nav-production-runs").click()
    await page.get_by_test_id("button-toggle-create-run").click()
    options = page.get_by_test_id("select-run-brand").locator("option")
    assert renamed not in await options.all_text_contents()
    await page.get_by_test_id("select-run-brand").select_option(target_brand)
    await expect(page.get_by_test_id("select-run-flavor").locator(f'option[value="{target["id"]}"]')).to_contain_text(f"rev {merged['revision']}")
    await check_snapshot()

    # Another authenticated device edits while the first device has an open form.
    await page.goto(f"{base}/imports")
    target_card = page.get_by_test_id(f"card-profile-{target['id']}")
    await target_card.get_by_role("button", name="Rename profile", exact=True).click()
    await target_card.get_by_label("Brand", exact=True).fill(f"Stale {token}")
    # Model a second device with its own cookie jar. Sharing a cookie jar would
    # let its session bootstrap rotate the first tab's CSRF cookie mid-edit.
    other_context = await page.context.browser.new_context(
        storage_state=await page.context.storage_state(),
    )
    other = await other_context.new_page()
    try:
        await other.goto(f"{base}/imports")
        other_card = other.get_by_test_id(f"card-profile-{target['id']}")
        await other_card.get_by_role("button", name="Rename profile", exact=True).click()
        await other_card.get_by_label("Brand", exact=True).fill(winner)
        async with other.expect_response(response("PATCH", f"/v2/product-profiles/{target['id']}")) as pending:
            await other_card.get_by_role("button", name="Save rename", exact=True).click()
        won = await pending.value
        assert won.ok, await won.text()
        winning_profile = (await won.json())["profile"]
        # Refetch while the stale draft stays open: must not silently rebase it.
        # The app intentionally considers list data fresh for 15 seconds.
        # Model a real hidden->visible transition after that freshness window.
        await page.evaluate("""() => {
          Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'});
          document.dispatchEvent(new Event('visibilitychange'));
          window.dispatchEvent(new Event('visibilitychange'));
        }""")
        await page.wait_for_timeout(16_000)
        async with page.expect_response(response("GET", "/v2/product-profiles")):
            await page.evaluate("""() => {
              Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'visible'});
              document.dispatchEvent(new Event('visibilitychange'));
              window.dispatchEvent(new Event('visibilitychange'));
              delete document.visibilityState;
            }""")
        await expect(target_card.get_by_role("heading")).to_have_text(f"{winner} / Target flavor")
        async with page.expect_response(response("PATCH", f"/v2/product-profiles/{target['id']}")) as pending:
            await target_card.get_by_role("button", name="Save rename", exact=True).click()
        rejected = await pending.value
        assert rejected.status == 409, await rejected.text()
        await expect(target_card.get_by_role("alert")).to_contain_text("Revision conflict")
        await page.reload()
        target_card = page.get_by_test_id(f"card-profile-{target['id']}")
        await expect(target_card.get_by_role("heading")).to_have_text(f"{winner} / Target flavor")
        await expect(target_card).to_contain_text(f"REV {winning_profile['revision']:02d}")
        await target_card.get_by_role("button", name="Rename profile", exact=True).click()
        await expect(target_card.get_by_label("Brand", exact=True)).to_have_value(winner)
        await target_card.get_by_role("button", name="Cancel", exact=True).click()
    finally:
        await other_context.close()
    await check_snapshot()
    return {"runId": run_id, "profileId": profile_id, "targetId": target["id"], "result": "passed"}


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--storage-state", required=True)
    args = parser.parse_args()
    if os.environ.get("E2E_ALLOW_SYNTHETIC_WRITES") != "1":
        raise RuntimeError("Set E2E_ALLOW_SYNTHETIC_WRITES=1 only for a disposable development facility.")
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        context = await browser.new_context(storage_state=args.storage_state)
        try:
            print(json.dumps(await run_journey(await context.new_page(), args.base_url)))
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
