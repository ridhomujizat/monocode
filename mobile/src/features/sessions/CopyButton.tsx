import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { Pressable } from "react-native";

import { Icon } from "@/ui/Icon";
import { withAlpha, themedStyles, useColors } from "@/ui/theme";

/** Copies `text`, then shows a check for two seconds. */
export function CopyButton({ text, label = "Copy response" }: { text: string; label?: string }) {
  const colors = useColors();
  const styles = useStyles();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Pressable
      onPress={async () => {
        try {
          await Clipboard.setStringAsync(text);
        } catch {
          return;
        }
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2000);
      }}
      accessibilityRole="button"
      accessibilityLabel={copied ? "Copied" : label}
      hitSlop={6}
      style={({ pressed }) => [styles.button, pressed && styles.active]}
    >
      <Icon name={copied ? "check" : "copy"} size={16} color={withAlpha(colors.content, 0.4)} />
    </Pressable>
  );
}

const useStyles = themedStyles((colors) => ({
  button: {
    padding: 4,
    borderRadius: 6,
  },
  active: {
    backgroundColor: withAlpha(colors.content, 0.08),
  },
}));
