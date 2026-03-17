import { useMemo, useState } from "react"
import { Check, ChevronsUpDown } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

interface MultiSelectProps {
  options: string[]
  value: string[]
  placeholder?: string
  onChange: (next: string[]) => void
}

export function MultiSelect({ options, value, placeholder = "请选择", onChange }: MultiSelectProps) {
  const [open, setOpen] = useState(false)

  const summary = useMemo(() => {
    if (value.length === 0) {
      return placeholder
    }
    if (value.length <= 2) {
      return value.join("、")
    }
    return `已选择 ${value.length} 项`
  }, [placeholder, value])

  const handleToggle = (item: string) => {
    const exists = value.includes(item)
    const next = exists ? value.filter((v) => v !== item) : [...value, item]
    onChange(next)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} className="h-10 w-full justify-between">
          <span className="truncate text-left">{summary}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command>
          <CommandInput placeholder="搜索指标名称" />
          <CommandList>
            <CommandEmpty>没有匹配项</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem key={option} value={option} onSelect={() => handleToggle(option)}>
                  <Check className={cn("mr-2 h-4 w-4", value.includes(option) ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{option}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
