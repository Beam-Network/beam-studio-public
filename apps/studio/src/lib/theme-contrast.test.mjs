import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const stylesheet = readFileSync(
  new URL("../styles.css", import.meta.url),
  "utf8",
);
const themes = [":root", ".dark"].map((selector) => {
  const block = stylesheet.split(`${selector} {`)[1].split("\n  }")[0];
  const values = Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [
      name,
      value.trim(),
    ]),
  );
  function resolveColor(name, visited = new Set()) {
    assert.ok(!visited.has(name), `Circular color alias: ${name}`);
    visited.add(name);
    const value = values[name];
    const alias = /^var\(--([\w-]+)\)$/.exec(value);
    if (alias) return resolveColor(alias[1], visited);
    const channels = /^([\d.]+) ([\d.]+)% ([\d.]+)%$/.exec(value);
    return channels ? hsl(...channels.slice(1).map(Number)) : null;
  }
  const colors = Object.fromEntries(
    Object.keys(values)
      .map((name) => [name, resolveColor(name)])
      .filter(([, color]) => color !== null),
  );
  return { name: selector === ":root" ? "light" : "dark", colors };
});

function hsl(hue, saturation, lightness) {
  const light = lightness / 100;
  const amplitude = (saturation / 100) * Math.min(light, 1 - light);
  return [0, 8, 4].map((offset) => {
    const k = (offset + hue / 30) % 12;
    return light - amplitude * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  });
}

function composite(foreground, background, opacity) {
  return foreground.map(
    (value, index) => value * opacity + background[index] * (1 - opacity),
  );
}

function luminance(color) {
  return color.reduce((sum, channel, index) => {
    const linear =
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
}

function check(foreground, background, minimum, label) {
  const values = [luminance(foreground), luminance(background)].sort(
    (a, b) => a - b,
  );
  const ratio = (values[1] + 0.05) / (values[0] + 0.05);
  assert.ok(ratio >= minimum, `${label}: ${ratio.toFixed(3)}:1 < ${minimum}:1`);
}

for (const { name, colors } of themes) {
  test(`${name}: body text and links meet AA on shared surfaces`, () => {
    for (const surface of [
      "background",
      "card",
      "popover",
      "muted",
      "secondary",
      "accent",
    ]) {
      for (const ink of ["foreground", "muted-foreground", "primary"]) {
        check(colors[ink], colors[surface], 4.5, `${ink} on ${surface}`);
      }
    }
  });

  test(`${name}: status text and primary text remain readable on tinted panels`, () => {
    for (const surface of ["background", "card", "popover"]) {
      for (const tone of [
        "primary",
        "success",
        "warning",
        "running",
        "info",
        "destructive",
      ]) {
        const tint = composite(colors[tone], colors[surface], 0.1);
        check(colors[tone], tint, 4.5, `${tone} on ${surface} with 10% tint`);
        check(colors[`${tone}-foreground`], colors[tone], 4.5, `${tone} fill`);
      }
    }
    check(colors["brand-foreground"], colors.brand, 4.5, "brand button");
  });

  test(`${name}: focus, field boundaries and switches remain distinguishable`, () => {
    for (const surface of ["background", "card", "popover", "secondary"]) {
      for (const ink of ["ring", "input"]) {
        check(colors[ink], colors[surface], 3, `${ink} on ${surface}`);
      }
    }
    check(
      colors["sidebar-ring"],
      colors["sidebar-background"],
      3,
      "sidebar focus",
    );
    check(colors.background, colors.primary, 3, "checked switch thumb");
    check(colors.background, colors.input, 3, "unchecked switch thumb");
  });

  test(`${name}: graph connection colors meet non-text contrast`, () => {
    for (const tone of [
      "primary",
      "muted-foreground",
      "info",
      "warning",
      "destructive",
    ]) {
      check(colors[tone], colors.background, 3, `${tone} connection`);
    }
    check(colors["chart-completed"], colors.card, 3, "completed chart marks");
  });
}
