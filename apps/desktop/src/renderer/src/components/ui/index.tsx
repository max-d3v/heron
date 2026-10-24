import { Check, ChevronDown, LoaderCircle, X } from "lucide-react";
import { AlertDialog, Checkbox as RCheckbox, Dialog as RDialog, Select as RSelect, Switch as RSwitch, Tooltip as RTooltip } from "radix-ui";
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

// Small set of controls styled after macOS (AppKit) rather than a web dashboard.

type ButtonVariant = "default" | "primary" | "danger" | "ghost";

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md"; icon?: ReactNode; busy?: boolean }
>(function Button({ variant = "default", size = "md", icon, busy, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || busy}
      className={cn(
        "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] font-[450] transition-[background,opacity] disabled:opacity-45",
        size === "sm" ? "h-[22px] px-2 text-[12px]" : "h-[26px] px-2.5 text-[13px]",
        variant === "default" && "bg-content text-fg shadow-[0_0_0_0.5px_var(--line-strong),0_1px_1px_rgba(0,0,0,0.06)] active:bg-selected enabled:hover:bg-content-2",
        variant === "primary" && "bg-accent text-white shadow-[0_0_0_0.5px_rgba(0,0,0,0.1)] enabled:hover:brightness-105 active:brightness-95",
        variant === "danger" && "bg-content text-bad shadow-[0_0_0_0.5px_var(--line-strong)] enabled:hover:bg-content-2",
        variant === "ghost" && "text-fg-2 enabled:hover:bg-hover enabled:hover:text-fg active:bg-selected",
        className,
      )}
      {...rest}
    >
      {busy ? <LoaderCircle className="spin size-3.5" /> : icon}
      {children}
    </button>
  );
});

export function IconButton({
  label,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <Tooltip content={label}>
      <button
        aria-label={label}
        className={cn(
          "inline-flex size-[26px] items-center justify-center rounded-[6px] text-fg-2 enabled:hover:bg-hover enabled:hover:text-fg active:bg-selected disabled:opacity-40",
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
}

export function Tooltip({ content, children, side = "bottom" }: { content: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <RTooltip.Root delayDuration={500}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          className="z-50 max-w-xs rounded-[5px] bg-content-2 px-2 py-1 text-[11px] text-fg shadow-pop"
        >
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

export const TooltipProvider = RTooltip.Provider;

export const TextField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextField(
  { className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-[24px] rounded-[5px] bg-content px-2 text-[13px] text-fg shadow-[inset_0_0_0_0.5px_var(--line-strong)] outline-none placeholder:text-fg-3 focus:shadow-[0_0_0_3px_var(--accent-soft),inset_0_0_0_1px_var(--accent)]",
        className,
      )}
      {...rest}
    />
  );
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea(
  { className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      spellCheck={false}
      className={cn(
        "w-full resize-none rounded-[6px] bg-content p-2.5 font-mono text-[12px] leading-[1.5] text-fg shadow-[inset_0_0_0_0.5px_var(--line-strong)] outline-none focus:shadow-[0_0_0_3px_var(--accent-soft),inset_0_0_0_1px_var(--accent)]",
        className,
      )}
      {...rest}
    />
  );
});

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <RSwitch.Root
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={label}
      className="relative h-[16px] w-[26px] shrink-0 rounded-full bg-[var(--line-strong)] transition-colors data-[state=checked]:bg-accent disabled:opacity-45"
    >
      <RSwitch.Thumb className="block size-[14px] translate-x-[1px] rounded-full bg-white shadow-[0_0.5px_2px_rgba(0,0,0,0.3)] transition-transform data-[state=checked]:translate-x-[11px]" />
    </RSwitch.Root>
  );
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <RCheckbox.Root
      checked={checked}
      onCheckedChange={(v) => onChange(v === true)}
      aria-label={label}
      className="flex size-[14px] shrink-0 items-center justify-center rounded-[4px] bg-content shadow-[inset_0_0_0_0.5px_var(--line-strong),0_0.5px_1px_rgba(0,0,0,0.08)] data-[state=checked]:bg-accent data-[state=checked]:shadow-none"
    >
      <RCheckbox.Indicator>
        <Check className="size-[11px] text-white" strokeWidth={3} />
      </RCheckbox.Indicator>
    </RCheckbox.Root>
  );
}

export interface SelectOption {
  value: string;
  label: ReactNode;
  hint?: string;
}

export function Select({
  value,
  onChange,
  options,
  placeholder,
  className,
  disabled,
}: {
  value: string | undefined;
  onChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <RSelect.Root value={value} onValueChange={onChange} disabled={disabled}>
      <RSelect.Trigger
        className={cn(
          "inline-flex h-[24px] min-w-[120px] items-center justify-between gap-2 rounded-[6px] bg-content pl-2.5 pr-1.5 text-[13px] text-fg shadow-[0_0_0_0.5px_var(--line-strong),0_1px_1px_rgba(0,0,0,0.06)] outline-none disabled:opacity-45 data-[placeholder]:text-fg-3",
          className,
        )}
      >
        <span className="truncate">
          <RSelect.Value placeholder={placeholder} />
        </span>
        <RSelect.Icon>
          <ChevronDown className="size-3.5 text-fg-2" />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-[320px] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-[8px] bg-content-2/95 p-1 shadow-pop backdrop-blur-xl"
        >
          <RSelect.Viewport>
            {options.map((o) => (
              <RSelect.Item
                key={o.value}
                value={o.value}
                className="relative flex h-[24px] items-center rounded-[5px] pl-6 pr-3 text-[13px] text-fg outline-none data-[highlighted]:bg-accent data-[highlighted]:text-white"
              >
                <RSelect.ItemIndicator className="absolute left-1.5">
                  <Check className="size-3" strokeWidth={2.5} />
                </RSelect.ItemIndicator>
                <RSelect.ItemText>{o.label}</RSelect.ItemText>
                {o.hint && <span className="ml-3 text-[11px] opacity-60">{o.hint}</span>}
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}

/** macOS segmented control. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = "md",
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: ReactNode }>;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div role="tablist" className={cn("inline-flex rounded-[7px] bg-field p-[2px]", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-[5px] px-2.5 font-[450] text-fg-2 transition-colors",
            size === "sm" ? "h-[20px] text-[12px]" : "h-[22px] text-[12.5px]",
            value === o.value ? "bg-content text-fg shadow-[0_0_0_0.5px_var(--line),0_1px_2px_rgba(0,0,0,0.1)]" : "hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cn("spin size-3.5 text-fg-2", className)} />;
}

export function Badge({ children, tone = "gray", className }: { children: ReactNode; tone?: "gray" | "green" | "red" | "orange" | "blue" | "purple" | "teal"; className?: string }) {
  const tones = {
    gray: "bg-field text-fg-2",
    green: "bg-[color-mix(in_srgb,var(--green)_15%,transparent)] text-ok",
    red: "bg-[color-mix(in_srgb,var(--red)_14%,transparent)] text-bad",
    orange: "bg-[color-mix(in_srgb,var(--orange)_15%,transparent)] text-warn",
    blue: "bg-accent-soft text-accent",
    purple: "bg-[color-mix(in_srgb,var(--purple)_15%,transparent)] text-purple",
    teal: "bg-[color-mix(in_srgb,var(--teal)_15%,transparent)] text-teal",
  };
  return <span className={cn("inline-flex h-[18px] items-center rounded-[4px] px-1.5 text-[11px] font-medium", tones[tone], className)}>{children}</span>;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 520,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay data-overlay className="fixed inset-0 z-40 bg-black/20" />
        <RDialog.Content
          style={{ width }}
          className="fixed left-1/2 top-[12%] z-50 max-h-[76vh] -translate-x-1/2 overflow-hidden rounded-[12px] bg-content shadow-pop outline-none flex flex-col"
        >
          <div className="flex items-start justify-between gap-4 px-5 pt-4">
            <div>
              <RDialog.Title className="text-[14px] font-semibold">{title}</RDialog.Title>
              {description && <RDialog.Description className="mt-1 text-[12px] text-fg-2">{description}</RDialog.Description>}
            </div>
            <RDialog.Close className="rounded-[5px] p-0.5 text-fg-3 hover:bg-hover hover:text-fg" aria-label="Close">
              <X className="size-4" />
            </RDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-5 py-3">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

export function Confirm({
  open,
  onOpenChange,
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay data-overlay className="fixed inset-0 z-40 bg-black/20" />
        <AlertDialog.Content className="fixed left-1/2 top-[22%] z-50 w-[300px] -translate-x-1/2 rounded-[12px] bg-content-2 p-4 text-center shadow-pop outline-none">
          <img src="./heron.png" alt="" className="mx-auto mb-2 size-12" onError={(e) => (e.currentTarget.style.display = "none")} />
          <AlertDialog.Title className="text-[13px] font-semibold">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-1.5 text-[11.5px] leading-[1.45] text-fg-2">{message}</AlertDialog.Description>
          <div className="mt-4 flex flex-col gap-1.5">
            <AlertDialog.Action asChild>
              <Button variant={danger ? "danger" : "primary"} className={cn("w-full", danger && "!bg-bad !text-white")} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </AlertDialog.Action>
            <AlertDialog.Cancel asChild>
              <Button className="w-full">Cancel</Button>
            </AlertDialog.Cancel>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** A labelled row in a settings form. */
export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode; align?: "center" | "start" }) {
  return (
    <div className="grid grid-cols-[minmax(120px,180px)_1fr] items-start gap-x-4 py-2">
      <div className="text-right text-[13px] leading-[26px] text-fg">{label}</div>
      <div className="min-w-0">
        <div className="flex min-h-[26px] flex-col items-start justify-center">{children}</div>
        {hint && <div className="mt-1 text-[11.5px] leading-[1.4] text-fg-2">{hint}</div>}
      </div>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      {icon && <div className="text-fg-3">{icon}</div>}
      <div className="text-[14px] font-medium text-fg-2">{title}</div>
      {children && <div className="max-w-sm text-[12px] text-fg-3">{children}</div>}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div className="selectable rounded-[6px] bg-[color-mix(in_srgb,var(--red)_10%,transparent)] px-2.5 py-1.5 text-[12px] text-bad">{children}</div>;
}
