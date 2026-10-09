import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SIDEBAR_WIDTH = 256;
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_WIDTH_ICON = "3.25rem";
const SIDEBAR_OPEN_STORAGE_KEY = "beam-studio.sidebar.open";
const SIDEBAR_WIDTH_STORAGE_KEY = "beam-studio.sidebar.width";

let sidebarOpenSnapshot: boolean | undefined;
let sidebarWidthSnapshot: number | undefined;

type SidebarContextValue = {
  isMobile: boolean;
  open: boolean;
  openMobile: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setOpenMobile: React.Dispatch<React.SetStateAction<boolean>>;
  state: "expanded" | "collapsed";
  toggleSidebar: () => void;
  width: number;
  maxWidth: number;
  setWidth: (width: number, remember?: boolean) => void;
  resizing: boolean;
  setResizing: (resizing: boolean) => void;
};

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

function useSidebar() {
  const context = React.useContext(SidebarContext);

  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }

  return context;
}

function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState(false);

  React.useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 767px)");
    const updateIsMobile = () => setIsMobile(mediaQuery.matches);

    updateIsMobile();
    mediaQuery.addEventListener("change", updateIsMobile);
    return () => mediaQuery.removeEventListener("change", updateIsMobile);
  }, []);

  return isMobile;
}

const SidebarProvider = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & {
    defaultOpen?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }
>(
  (
    {
      defaultOpen = true,
      open: openProp,
      onOpenChange,
      className,
      style,
      children,
      ...props
    },
    ref,
  ) => {
    const isMobile = useIsMobile();
    const [_open, _setOpen] = React.useState(
      () => sidebarOpenSnapshot ?? defaultOpen,
    );
    const [openMobile, setOpenMobile] = React.useState(false);
    const open = openProp ?? _open;
    const [preferredWidth, setPreferredWidth] = React.useState(
      () => sidebarWidthSnapshot ?? SIDEBAR_WIDTH,
    );
    const [viewportWidth, setViewportWidth] = React.useState(1280);
    const [resizing, setResizing] = React.useState(false);
    const maxWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - 320));
    const width = Math.min(preferredWidth, maxWidth);

    React.useEffect(() => {
      const onResize = () => setViewportWidth(window.innerWidth);
      onResize();
      try {
        const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
        if (Number.isFinite(saved) && saved >= SIDEBAR_MIN_WIDTH && saved <= SIDEBAR_MAX_WIDTH) {
          sidebarWidthSnapshot = saved;
          setPreferredWidth(saved);
        }
      } catch { /* Browser storage is optional for resizing. */ }
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }, []);

    const setWidth = React.useCallback((value: number, remember = true) => {
      if (!Number.isFinite(value)) return;
      const next = Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(maxWidth, value)));
      setPreferredWidth(next);
      sidebarWidthSnapshot = next;
      if (remember) {
        try { localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(next)); }
        catch { /* Retain the current width for this session. */ }
      }
    }, [maxWidth]);

    React.useEffect(() => {
      if (!resizing) return;
      const { cursor, userSelect } = document.body.style;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      return () => {
        document.body.style.cursor = cursor;
        document.body.style.userSelect = userSelect;
      };
    }, [resizing]);

    React.useEffect(() => {
      if (openProp !== undefined) {
        return;
      }

      try {
        const storedOpen = localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY);
        if (storedOpen === "1" || storedOpen === "0") {
          const nextOpen = storedOpen === "1";
          sidebarOpenSnapshot = nextOpen;
          _setOpen(nextOpen);
        }
      } catch {
        // Keep the default state when storage is unavailable.
      }
    }, [openProp]);

    const setOpen = React.useCallback(
      (value: React.SetStateAction<boolean>) => {
        const nextOpen = typeof value === "function" ? value(open) : value;
        onOpenChange?.(nextOpen);

        if (openProp === undefined) {
          sidebarOpenSnapshot = nextOpen;
          try {
            localStorage.setItem(
              SIDEBAR_OPEN_STORAGE_KEY,
              nextOpen ? "1" : "0",
            );
          } catch {
            // The sidebar remains usable when storage is unavailable.
          }
          _setOpen(nextOpen);
        }
      },
      [onOpenChange, open, openProp],
    );

    const toggleSidebar = React.useCallback(() => {
      if (isMobile) {
        setOpenMobile((value) => !value);
        return;
      }

      setOpen((value) => !value);
    }, [isMobile, setOpen]);

    React.useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "b" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          toggleSidebar();
        }
      };

      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }, [toggleSidebar]);

    const state: SidebarContextValue["state"] = open ? "expanded" : "collapsed";

    const contextValue = React.useMemo(
      () => ({
        isMobile,
        open,
        openMobile,
        setOpen,
        setOpenMobile,
        state,
        toggleSidebar,
        width,
        maxWidth,
        setWidth,
        resizing,
        setResizing,
      }),
      [isMobile, open, openMobile, setOpen, state, toggleSidebar, width, maxWidth, setWidth, resizing],
    );

    return (
      <SidebarContext.Provider value={contextValue}>
        <div
          className={cn(
            "group/sidebar-wrapper flex h-svh w-svw overflow-hidden",
            className,
          )}
          ref={ref}
          style={
            {
              "--sidebar-width": `${isMobile ? SIDEBAR_WIDTH : width}px`,
              "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
              ...style,
            } as React.CSSProperties
          }
          {...props}
        >
          {children}
        </div>
      </SidebarContext.Provider>
    );
  },
);
SidebarProvider.displayName = "SidebarProvider";

const Sidebar = React.forwardRef<
  HTMLElement,
  React.ComponentProps<"aside"> & {
    collapsible?: "icon" | "none";
  }
>(({ className, collapsible = "icon", children, ...props }, ref) => {
  const { openMobile, setOpenMobile, state, resizing } = useSidebar();

  return (
    <>
      <aside
        className={cn(
          "group/sidebar peer fixed inset-y-0 left-0 z-40 flex h-svh w-[--sidebar-width] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[transform,width] duration-200 md:relative md:z-auto",
          resizing && "transition-none",
          openMobile ? "translate-x-0" : "-translate-x-full md:translate-x-0",
          collapsible === "icon" && state === "collapsed"
            ? "md:w-[--sidebar-width-icon]"
            : "md:w-[--sidebar-width]",
          className,
        )}
        data-collapsible={
          collapsible === "icon" && state === "collapsed" ? "icon" : ""
        }
        data-state={state}
        ref={ref}
        {...props}
      >
        {children}
      </aside>
      {openMobile ? (
        <button
          aria-label="Close Sidebar"
          className="fixed inset-0 z-30 bg-background/80 md:hidden"
          onClick={() => setOpenMobile(false)}
          type="button"
        />
      ) : null}
    </>
  );
});
Sidebar.displayName = "Sidebar";

const SidebarInset = React.forwardRef<
  HTMLElement,
  React.ComponentProps<"main">
>(({ className, ...props }, ref) => (
  <main
    className={cn(
      "flex h-svh min-w-0 flex-1 flex-col overflow-hidden bg-background",
      className,
    )}
    ref={ref}
    {...props}
  />
));
SidebarInset.displayName = "SidebarInset";

const SidebarTrigger = React.forwardRef<
  React.ElementRef<typeof Button>,
  React.ComponentProps<typeof Button>
>(({ className, onClick, ...props }, ref) => {
  const { toggleSidebar } = useSidebar();

  return (
    <Button
      className={cn("h-9 w-9", className)}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      ref={ref}
      size="icon"
      type="button"
      variant="ghost"
      {...props}
    >
      <PanelLeft className="h-4 w-4" />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  );
});
SidebarTrigger.displayName = "SidebarTrigger";

const SidebarHeader = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, ...props }, ref) => (
  <div
    className={cn(
      "flex h-14 shrink-0 flex-col justify-center gap-1 border-b border-sidebar-border px-3 py-2",
      className,
    )}
    data-sidebar="header"
    ref={ref}
    {...props}
  />
));
SidebarHeader.displayName = "SidebarHeader";

const SidebarContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, ...props }, ref) => (
  <div
    className={cn(
      "flex min-h-0 flex-1 flex-col gap-3 overflow-hidden pt-2",
      className,
    )}
    data-sidebar="content"
    ref={ref}
    {...props}
  />
));
SidebarContent.displayName = "SidebarContent";

const SidebarFooter = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, ...props }, ref) => (
  <div
    className={cn(
      "flex shrink-0 flex-col border-t border-sidebar-border p-2 group-data-[collapsible=icon]/sidebar:items-center",
      className,
    )}
    data-sidebar="footer"
    ref={ref}
    {...props}
  />
));
SidebarFooter.displayName = "SidebarFooter";

const SidebarGroup = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, ...props }, ref) => (
  <div
    className={cn(
      "relative flex w-full min-w-0 flex-col group-data-[collapsible=icon]/sidebar:items-center",
      className,
    )}
    data-sidebar="group"
    ref={ref}
    {...props}
  />
));
SidebarGroup.displayName = "SidebarGroup";

const SidebarGroupLabel = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, ...props }, ref) => (
  <div
    className={cn(
      "flex h-8 items-center px-2 text-xs font-medium text-sidebar-foreground/65 group-data-[collapsible=icon]/sidebar:hidden",
      className,
    )}
    data-sidebar="group-label"
    ref={ref}
    {...props}
  />
));
SidebarGroupLabel.displayName = "SidebarGroupLabel";

const SidebarGroupContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, ...props }, ref) => (
  <div
    className={cn(
      "w-full text-sm group-data-[collapsible=icon]/sidebar:w-auto",
      className,
    )}
    data-sidebar="group-content"
    ref={ref}
    {...props}
  />
));
SidebarGroupContent.displayName = "SidebarGroupContent";

const SidebarMenu = React.forwardRef<
  HTMLUListElement,
  React.ComponentProps<"ul">
>(({ className, ...props }, ref) => (
  <ul
    className={cn(
      "flex w-full min-w-0 flex-col gap-1 group-data-[collapsible=icon]/sidebar:w-auto group-data-[collapsible=icon]/sidebar:items-center",
      className,
    )}
    data-sidebar="menu"
    ref={ref}
    {...props}
  />
));
SidebarMenu.displayName = "SidebarMenu";

const SidebarMenuItem = React.forwardRef<
  HTMLLIElement,
  React.ComponentProps<"li">
>(({ className, ...props }, ref) => (
  <li
    className={cn("group/menu-item relative", className)}
    data-sidebar="menu-item"
    ref={ref}
    {...props}
  />
));
SidebarMenuItem.displayName = "SidebarMenuItem";

const sidebarMenuButtonVariants = cva(
  "flex h-10 w-full items-center gap-2.5 overflow-hidden rounded-control px-2.5 text-left font-sans text-[0.9rem] font-medium outline-none transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[active=true]:bg-primary/10 data-[active=true]:font-semibold data-[active=true]:text-sidebar-accent-foreground group-data-[collapsible=icon]/sidebar:w-10 group-data-[collapsible=icon]/sidebar:justify-center group-data-[collapsible=icon]/sidebar:px-0 group-data-[collapsible=icon]/sidebar:[&>span]:sr-only [&>span]:truncate [&>svg]:h-[1.125rem] [&>svg]:w-[1.125rem] [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "",
        outline: "border border-sidebar-border bg-background",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

const SidebarMenuButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> & {
    asChild?: boolean;
    isActive?: boolean;
  } & VariantProps<typeof sidebarMenuButtonVariants>
>(
  (
    { asChild = false, className, isActive = false, variant, ...props },
    ref,
  ) => {
    const Comp = asChild ? Slot : "button";

    return (
      <Comp
        className={cn(sidebarMenuButtonVariants({ variant }), className)}
        data-active={isActive}
        data-sidebar="menu-button"
        ref={ref}
        {...props}
      />
    );
  },
);
SidebarMenuButton.displayName = "SidebarMenuButton";

const SidebarRail = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div">
>(({ className, ...props }, ref) => {
  const { isMobile, open, width, maxWidth, setWidth, setResizing } = useSidebar();
  const drag = React.useRef<{ startX: number; width: number; current: number } | null>(null);
  React.useEffect(() => () => setResizing(false), [setResizing]);
  if (isMobile || !open) return null;

  return (
    <div
      {...props}
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      className={cn(
        "absolute inset-y-0 right-0 z-50 hidden w-3 translate-x-1/2 cursor-col-resize touch-none md:block",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-px hover:after:bg-primary focus-visible:outline-none focus-visible:after:bg-primary focus-visible:after:w-1",
        className,
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { startX: event.clientX, width, current: width };
        setResizing(true);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        drag.current.current = drag.current.width + event.clientX - drag.current.startX;
        setWidth(drag.current.current, false);
      }}
      onPointerUp={(event) => {
        if (!drag.current) return;
        setWidth(drag.current.current);
        drag.current = null;
        setResizing(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        if (drag.current) setWidth(drag.current.width);
        drag.current = null;
        setResizing(false);
      }}
      onDoubleClick={() => setWidth(SIDEBAR_WIDTH)}
      onKeyDown={(event) => {
        const increment = event.shiftKey ? 32 : 8;
        const next = event.key === "ArrowLeft" ? width - increment
          : event.key === "ArrowRight" ? width + increment
          : event.key === "Home" ? SIDEBAR_MIN_WIDTH
          : event.key === "End" ? maxWidth
          : event.key === "Enter" ? SIDEBAR_WIDTH : null;
        if (next === null) return;
        event.preventDefault();
        setWidth(next);
      }}
      ref={ref}
      tabIndex={0}
      title="Drag or use arrow keys to resize; double-click to reset"
    />
  );
});
SidebarRail.displayName = "SidebarRail";

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
};
