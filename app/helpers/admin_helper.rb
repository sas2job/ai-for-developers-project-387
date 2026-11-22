module AdminHelper
  def event_type_filter_options(event_types, all_types_label)
    name_counts = event_types.map { |event_type| event_type.name.squish }.tally

    event_types.map do |event_type|
      name = event_type.name.squish
      label = if name == all_types_label || name_counts.fetch(name) > 1
        "#{name} (#{event_type.duration_minutes} мин., №#{event_type.id})"
      else
        event_type.name
      end

      [ label, event_type.id ]
    end
  end
end
