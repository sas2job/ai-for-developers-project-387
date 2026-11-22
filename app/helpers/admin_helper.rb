module AdminHelper
  def event_type_filter_options(event_types, all_types_label)
    entries = event_types.map do |event_type|
      name = event_type.name.squish
      detailed_label = "#{name} (#{event_type.duration_minutes} мин., №#{event_type.id})"
      [ name, detailed_label, event_type ]
    end
    name_counts = entries.map(&:first).tally
    reserved_labels = entries.map { |_, detailed_label| detailed_label }.to_set.add(all_types_label)

    entries.map do |name, detailed_label, event_type|
      label = if reserved_labels.include?(name) || name_counts.fetch(name) > 1
        detailed_label
      else
        event_type.name
      end

      [ label, event_type.id ]
    end
  end
end
